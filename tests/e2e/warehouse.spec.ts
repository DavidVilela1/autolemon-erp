/**
 * @file Browser end-to-end flow (real API + real Postgres + real browser):
 * invitation → password → TOTP enrolment → login with MFA → structure → SKU → receiving by
 * scanner → scan-verified putaway → stock visible; passkey registration, sign-in and step-up with a CDP virtual
 * authenticator; plus axe accessibility checks and CSP header presence.
 * @module tests/e2e
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { totpNow } from '../../apps/api/src/platform/auth/totp.js';

const PASSWORD = 'cavalo correto bateria agrafo 2026';
const token = process.env.E2E_INVITE!;
const email = process.env.E2E_EMAIL!;
let secret = '';

/** Waits for the next TOTP step so a fresh code is never a replay. */
async function freshCode(): Promise<string> {
  const msInStep = Date.now() % 30_000;
  await new Promise((r) => setTimeout(r, 30_000 - msInStep + 500));
  return totpNow(secret);
}

test.describe.configure({ mode: 'serial' });

/**
 * Navigates via the sidebar and waits until the target page's <h1> is rendered. Several pages
 * share field names (e.g. "Código"), so interacting before the route switch completes could
 * fill the previous page's form on slower machines (observed on GitHub runners).
 */
async function go(page: Page, link: string, heading: string): Promise<void> {
  await page.getByRole('link', { name: link, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

test('invitation enrolment, MFA login and accessible login page', async ({ page }) => {
  const res = await page.goto(`/#/convite/${token}`);
  expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page).toHaveURL(/#\/convite$/); // token removed from address bar
  await page.getByRole('textbox', { name: /Palavra-passe/ }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar' }).click();
  secret = (await page.getByLabel('Chave secreta TOTP').innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.getByRole('textbox', { name: 'Código de 6 dígitos' }).fill(totpNow(secret));
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Conta ativada')).toBeVisible();
  await page.getByRole('button', { name: 'Ir para o início de sessão' }).click();

  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await page.getByRole('textbox', { name: 'E-mail' }).fill(email);
  await page.getByRole('textbox', { name: 'Palavra-passe' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel(/Código da aplicação/).fill(await freshCode());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('heading', { name: 'Stock' })).toBeVisible();
  // No tokens in web storage.
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).toBe('{}{}');

  // --- structure
  await go(page, 'Estrutura', 'Estrutura do armazém');
  const createNode = async (kind: string, code: string, parent?: string) => {
    await page.getByRole('combobox', { name: 'Tipo', exact: true }).first().selectOption({ label: kind });
    if (parent) await page.getByLabel('Dentro de').selectOption({ label: parent });
    else await page.getByLabel('Dentro de').selectOption('');
    await page.getByRole('textbox', { name: 'Código', exact: true }).first().fill(code);
    await page.getByRole('textbox', { name: 'Nome', exact: true }).fill(code);
    await page.getByRole('button', { name: 'Criar localização' }).click();
    await expect(page.getByText('Localização criada.')).toBeVisible();
  };
  await createNode('Zona', 'Z1');
  await createNode('Estante', 'R1', 'Z1');
  await createNode('Prateleira', 'P1', 'Z1/R1');
  await createNode('Cais de receção', 'REC');
  // Unsupported nesting is refused with a clear message.
  await page.getByRole('combobox', { name: 'Tipo', exact: true }).first().selectOption({ label: 'Zona' });
  await page.getByLabel('Dentro de').selectOption({ label: 'Z1/R1' });
  await page.getByRole('textbox', { name: 'Código', exact: true }).first().fill('BAD');
  await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('BAD');
  await page.getByRole('button', { name: 'Criar localização' }).click();
  await expect(page.getByRole('alert')).toContainText('Não é suportado');

  // --- SKU with hostile description rendered as text
  await go(page, 'Artigos', 'Artigos');
  await page.getByRole('textbox', { name: 'Código', exact: true }).fill('BRK-E2E');
  await page.getByLabel('Código de barras (EAN)').fill('5600000009999');
  await page.getByRole('textbox', { name: 'Descrição', exact: true }).fill('<img src=x onerror="window.__xss=1">Pastilhas');
  await page.getByRole('button', { name: 'Criar', exact: true }).click();
  await expect(page.getByText('Artigo criado.')).toBeVisible();
  await expect(page.getByRole('cell', { name: '<img src=x onerror="window.__xss=1">Pastilhas' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // --- receiving with scanner input
  await go(page, 'Receção', 'Receção');
  await page
    .getByLabel('Artigo previsto (vazio = não planeada)')
    .selectOption({ label: 'BRK-E2E · <img src=x onerror="window.__xss=1">Pastilhas' });
  await page.getByRole('textbox', { name: 'Quantidade prevista' }).fill('5');
  await page.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByText('Entrada criada.')).toBeVisible();
  await page.getByLabel('Cais de receção').selectOption({ label: 'REC (STAGING)' });
  await page.getByLabel('Quantidade por leitura').fill('4');
  const scan = page.getByLabel('Ler código de barras do artigo');
  await scan.fill('5600000009999');
  await scan.press('Enter');
  await expect(page.getByText('Recebido 4 × 5600000009999.')).toBeVisible();
  await page.getByRole('button', { name: 'Fechar receção' }).click();
  await expect(page.getByText(/faltas\/excessos registados/)).toBeVisible();

  // --- putaway
  await go(page, 'Arrumação', 'Arrumação');
  await page.getByRole('button', { name: 'Arrumar' }).first().click();
  await page.getByLabel('Destino', { exact: true }).selectOption({ label: 'Z1/R1/P1 (SHELF)' });
  // Scan verification: a label from another location is refused, the right one accepted.
  await page.getByRole('textbox', { name: 'Ler etiqueta do destino' }).fill('REC');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByRole('alert')).toContainText('não corresponde ao destino');
  await page.getByRole('textbox', { name: 'Ler etiqueta do destino' }).fill('P1');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Arrumação registada.')).toBeVisible();

  // --- stock page shows 4 available units; accessibility of an operational screen
  await go(page, 'Stock', 'Stock');
  await expect(page.getByRole('row', { name: /BRK-E2E/ }).first()).toContainText('4');
  const a11y2 = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(a11y2.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // --- quality block: quarantine 1 unit in place (audited; blocking needs no step-up)
  await page.getByRole('button', { name: 'BRK-E2E' }).click();
  await page
    .getByRole('row', { name: /Disponível/ })
    .getByRole('button', { name: 'Estado' })
    .first()
    .click();
  await page.getByRole('textbox', { name: 'Quantidade' }).fill('1');
  await page.getByLabel('Novo estado').selectOption({ label: 'Quarentena' });
  await page.getByRole('textbox', { name: 'Motivo' }).fill('Embalagem danificada');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Estado alterado.')).toBeVisible();
  const quarantined = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Quarentena', exact: true }) });
  await expect(quarantined).toHaveCount(1);
  await expect(quarantined).toContainText('1');

  // --- logout ends the server session
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
  const r = await page.request.get('/api/auth/session');
  expect(r.status()).toBe(401);
});

test('passkey: register with step-up, sign in with it, step up with it (virtual authenticator)', async ({ page }) => {
  test.setTimeout(180_000);
  // Chrome DevTools Protocol virtual authenticator: a real WebAuthn ceremony in the real browser.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto('/#/entrar');
  await page.getByRole('textbox', { name: 'E-mail' }).fill(email);
  await page.getByRole('textbox', { name: 'Palavra-passe' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel(/Código da aplicação/).fill(await freshCode());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('heading', { name: 'Stock' })).toBeVisible();

  await go(page, 'A minha conta', 'A minha conta');
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Registration demands a fresh step-up (TOTP, since no passkey exists yet).
  await page.getByLabel('Nome da nova chave').fill('Chave E2E');
  await page.getByRole('button', { name: 'Registar chave de acesso' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirmar identidade' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Código de 6 dígitos' }).fill(await freshCode());
  await dialog.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Chave de acesso registada.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Chave E2E' })).toBeVisible();

  // Sign out, then sign in with password + passkey (no TOTP).
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
  await page.getByRole('textbox', { name: 'E-mail' }).fill(email);
  await page.getByRole('textbox', { name: 'Palavra-passe' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Usar chave de acesso' }).click();
  await expect(page.getByRole('heading', { name: 'Stock' })).toBeVisible();

  // Accessibility sweep: every screen reachable from the navigation passes axe (WCAG 2.2 AA tags).
  const links = await page.getByRole('navigation', { name: 'Principal' }).getByRole('link').allInnerTexts();
  expect(links.length).toBeGreaterThanOrEqual(15);
  for (const name of links) {
    await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /A carregar/ })).toHaveCount(0); // loaded
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(r.violations.map((v) => `${name} → ${v.id}: ${v.help} @ ${v.nodes.map((n) => n.html.slice(0, 120)).join(' | ')}`)).toEqual([]);
  }

  // Step-up with the passkey: regenerate recovery codes.
  await go(page, 'A minha conta', 'A minha conta');
  await page.getByRole('button', { name: 'Gerar novos códigos' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Usar chave de acesso' }).click();
  await expect(page.getByRole('list', { name: 'Novos códigos de recuperação' }).getByRole('listitem')).toHaveCount(10);
  await expect(page.getByRole('cell', { name: 'Esta sessão' })).toBeVisible();
});
