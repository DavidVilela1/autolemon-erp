# Manual do operador e do administrador — AutoLemon WMS v0.6.2

Módulo responsável: WMS / formação. Público: operadores de armazém, chefes de armazém e
administradores da empresa. Este manual descreve o que a aplicação faz **hoje**; não substitui a
formação prática nem o piloto com a equipa (critério O-06 do gate de lançamento).

## 1. Entrar no sistema

1. Abra o endereço indicado pelo administrador (em desenvolvimento: `http://localhost:5173`).
2. Primeira vez: abra o **link de convite** que recebeu, defina uma palavra-passe com pelo menos
   12 caracteres (pode ser uma frase), adicione a chave à aplicação autenticadora (Google ou
   Microsoft Authenticator, etc.) e **guarde os 10 códigos de recuperação** em local seguro.
3. Nas vezes seguintes: e-mail + palavra-passe, depois **Usar chave de acesso** (impressão
   digital, rosto, PIN do Windows Hello ou chave USB) **ou** o código de 6 dígitos.
4. Ações sensíveis (exportar, ajustar, libertar quarentena, reverter, gerir chaves) pedem
   **Confirmar identidade** — use a chave de acesso ou um código novo.
5. Sessões terminam após 30 min sem atividade ou 12 h no total. Use sempre **Sair** em
   computadores partilhados.

**Chave de acesso (recomendado):** _A minha conta_ → nome (ex.: "Portátil do armazém") →
_Registar chave de acesso_. Administradores em produção **têm** de usar chave de acesso.

## 2. O meu armazém

Cada operador vê apenas o armazém que lhe foi atribuído. Só o Administrador da empresa pode
mudar de armazém (seletor no topo). Se não vê um menu, não tem essa permissão — fale com o
chefe de armazém.

## 3. Tarefas do dia a dia

| Tarefa                    | Onde                                                 | Passos essenciais                                                                                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encontrar qualquer coisa  | **Pesquisa**                                         | número do documento, referência externa (guia, encomenda), código do artigo, código de barras, localização ou caixa → _Ir para…_                                                                                                                               |
| Receber mercadoria        | **Receção**                                          | escolher a entrada (ou criar entrada não prevista) → zona de receção → ler o código de barras → quantidade (uma leitura de caixa conta as unidades da caixa) → marcar danificado se for o caso → _Fechar_ quando terminar (faltas e excessos ficam registados) |
| Arrumar                   | **Arrumação**                                        | tarefa → destino → **ler a etiqueta do destino** → confirmar. Se a etiqueta lida não for a do destino escolhido, o sistema recusa                                                                                                                              |
| Mover stock / caixas      | **Stock** → _Mover_; **Estrutura** → caixa → _Mover_ | escolher destino e **ler a etiqueta do destino**                                                                                                                                                                                                               |
| Separar (picking)         | **Saídas**                                           | pedido → _Alocar_ → lista de separação por localização → ler o artigo → quantidade → zona de embalagem                                                                                                                                                         |
| Embalar e expedir         | **Saídas**                                           | _Novo volume_ → _Embalar aqui_ → _Expedir_ volumes → guia interna                                                                                                                                                                                              |
| Corrigir uma separação    | **Saídas**                                           | _Retirar_ (tira do volume) → _Anular separação_ (devolve à prateleira) → se o cliente desistiu, _Cancelar_                                                                                                                                                     |
| Transferir entre armazéns | **Transferências**                                   | origem: criar → _Expedir_ (o lote acompanha). Destino: _Receber_ (pode escolher o lote) → arrumar. Origem pode _Anular_ antes de expedir                                                                                                                       |
| Devoluções                | **Devoluções**                                       | receber → inspecionar → decidir: repor, quarentena, danificado/abate                                                                                                                                                                                           |
| Quarentena / libertar     | **Stock** → _Estado_                                 | bloquear (quarentena, danificado, inspeção) com motivo; libertar para Disponível exige confirmação de identidade e uma prateleira de destino                                                                                                                   |
| Contagens                 | **Contagens**                                        | criar (cíclica ou total) → contar às cegas (o sistema não mostra o esperado) → recontar se necessário → submeter. **Outra pessoa** aprova; quem contou nunca aprova                                                                                            |
| Reposição                 | **Reposição**                                        | regras mínimo/alvo por localização de picking → _Executar_ → levar o artigo → **ler a etiqueta do destino**                                                                                                                                                    |
| Etiquetas                 | **Etiquetas**                                        | artigos, localizações, caixas → imprimir (navegador)                                                                                                                                                                                                           |

## 4. Histórico, correções e relatórios

- **Histórico**: todos os movimentos (nunca se apagam). _Reverter_ anula um movimento uma única
  vez (confirmação de identidade); _Ajustar_ exige motivo e confirmação.
- **Exportar movimentos**: Histórico → datas _De/Até_ (máximo 366 dias) → _Exportar movimentos
  do período_. **Exportar stock**: Relatórios. Todas as exportações ficam registadas na auditoria.
- **Relatórios**: reconciliação (deve dizer que saldos e reservas coincidem), faltas/excessos na
  receção, diferenças de contagem, em trânsito.

## 5. Mensagens frequentes

| Mensagem                                                    | Significado                          | O que fazer                                                |
| ----------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| "O código lido não corresponde ao destino escolhido"        | leu a etiqueta errada                | vá à localização certa ou escolha o destino que está a ler |
| "Artigo lido não corresponde à linha"                       | artigo errado                        | confirme o artigo; não force a quantidade                  |
| "Confirme a sua identidade…" / caixa _Confirmar identidade_ | ação sensível                        | use a chave de acesso ou um código novo                    |
| "Existe stock nesta localização ou abaixo dela"             | tentou desativar localização ocupada | mova o stock e as caixas primeiro                          |
| "Existem unidades separadas ou expedidas"                   | cancelar pedido já separado          | _Retirar_ / _Anular separação_ primeiro                    |
| "Mais de 100000 movimentos no período"                      | exportação demasiado grande          | reduza o intervalo de datas                                |

## 6. Administração (só Administradores)

- **Utilizadores**: criar (um armazém por operador, permissões mínimas necessárias), desativar,
  _Repor MFA_ quando alguém perde o telemóvel/chave (remove códigos, autenticador **e chaves de
  acesso**; entregue o novo link por um canal verificado), _Repor palavra-passe_.
- **Auditoria**: consulta e _Verificar cadeia_ (deve dar OK). Uma falha é um incidente grave —
  ver `docs/runbooks/RUNBOOKS.md` §4.
- **Chaves de cifra**: _Rodar chaves_ anualmente ou em caso de suspeita.
- **A minha conta**: mantenha pelo menos duas chaves de acesso (ex.: portátil + chave USB) e os
  códigos de recuperação guardados fora do computador. Se perder tudo, siga o procedimento de
  emergência (`RUNBOOKS.md` §3) — exige outra pessoa.
- **Revisão trimestral**: quem tem _exportar_, _ajustar_ e _aprovar contagens_; desativar quem saiu.

## 7. Boas práticas de segurança

Nunca partilhe a palavra-passe, a chave de acesso ou códigos. Não aprove uma confirmação de
identidade que não pediu. Exportações contêm dados da empresa: guarde-as apenas em locais
autorizados e apague-as quando já não forem necessárias. Reporte de imediato comportamentos
estranhos ao administrador.
