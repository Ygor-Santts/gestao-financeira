# Finanças

Controle financeiro pessoal: um app para o celular (PWA) que mostra o que entrou, o que foi gasto de verdade e o que está guardado. Ele lê extratos e faturas em OFX, CSV e PDF.

A regra central do app: **dinheiro que vai para a caixinha ou para outra conta sua não é gasto**. Cada lançamento tem um destes tipos:

| Tipo | Exemplo | Conta como gasto? |
| --- | --- | --- |
| Entrou | salário, Pix recebido de outra pessoa | não (é entrada) |
| Gastou | compras, contas, fatura do cartão paga | **sim** |
| Caixinha | aplicação ou resgate de caixinha/RDB, Nu Reserva, cripto | não |
| Entre minhas contas | Pix da Nubank para a Caixa, da Nu Empresas para a conta pessoal | não |

## O que tem

- **Início**: quanto você tem hoje (conta + caixinhas), um resumo do mês em uma frase, previsão até o fim do mês, caixinhas, gastos por categoria e o ano.
- **Extrato**: lançamentos do mês por dia, com busca e filtros. Toque em um lançamento para corrigir tipo, categoria, valor ou data.
- **Importar**: envie o arquivo do banco (ou compartilhe direto do app do banco pelo Android). O app sugere tipo e categoria, aprende com as suas correções e deixa de fora o que já foi lançado. Cada importação pode ser desfeita.
- **Contas**: contas a pagar e entradas previstas do mês, com marcação de pago/recebido e criação do mês seguinte.
- **Mais**: caixinhas e metas, patrimônio, faturas dos cartões por categoria, mês a mês, backup e ajustes.

Formatos lidos:

- **OFX** de qualquer banco (conta ou cartão), incluindo Nubank, Nu Empresas, Caixa, Santander e BTG.
- **CSV** do Nubank: conta (`Data,Valor,Identificador,Descrição`) e cartão (`date,title,amount`). Outros CSV com colunas de data e valor também funcionam.
- **PDF** com texto: faturas da Caixa e do Santander e extratos com linhas de data e valor. PDF escaneado (imagem) não tem texto e é recusado com uma mensagem.

## Como é feito

Sem dependências externas: Node 22 com o SQLite embutido (`node:sqlite`), um servidor HTTP próprio e a interface em JavaScript puro (módulos ES), com service worker e manifest para instalar no celular.

```
server/           API, login e banco
  importers/      leitura de OFX, CSV e PDF + sugestão de categoria
public/           o app (HTML, CSS, JS, service worker, ícones)
test/             testes com dados inventados
```

O banco fica em `data/financas.db` (ou em `DB_FILE`). Extratos, backups, o banco e o `.env` estão no `.gitignore`: **nenhum dado financeiro vai para o repositório**.

## Rodar no seu computador

O app roda inteiro numa máquina sua: um processo (ou um container) e um arquivo de banco. Ele não depende de nenhum outro sistema.

### Com Docker (recomendado para deixar ligado)

```bash
cp .env.example .env        # e troque a senha
docker compose up -d --build
```

Abra `http://localhost:8080`. O container volta sozinho quando o PC reinicia (`restart: unless-stopped`) e o banco fica no volume `financas_data`.

```bash
docker compose logs -f      # ver o log
docker compose restart      # reiniciar
docker compose down         # parar (os dados ficam no volume)
git pull && docker compose up -d --build   # atualizar
```

### Sem Docker

Precisa do Node 22.13 ou mais novo e, para ler faturas em PDF, do `pdftotext` (pacote `poppler-utils` no Linux, `brew install poppler` no Mac).

```bash
FINANCAS_SENHA=uma-senha npm start     # http://localhost:8080
npm run dev                            # recarrega ao salvar
npm test
```

## Usar no celular

- **Na mesma rede Wi-Fi:** abra `http://IP-DO-PC:8080` no navegador do celular (o IP aparece com `ip addr` no Linux ou `ipconfig` no Windows). Já dá para usar tudo.
- **Para instalar como app e usar fora de casa:** o celular só instala o PWA (ícone na tela inicial, abrir offline, compartilhar extrato direto do app do banco) num endereço **HTTPS**. O jeito mais simples é o [Tailscale](https://tailscale.com), de graça para uso pessoal:
  1. instale o Tailscale no PC e no celular, com a mesma conta;
  2. no PC: `tailscale serve --bg 8080`;
  3. ele mostra um endereço `https://NOME-DO-PC.SEU-TAILNET.ts.net`, que só os seus aparelhos acessam. Abra-o no celular e use **Adicionar à tela inicial**.

  Assim nenhuma porta fica aberta para a internet.

## Primeiro uso

Entre com a senha, vá em **Mais › Backup › Restaurar** e escolha o arquivo de dados inicial (exportado da planilha). Depois é só importar os extratos novos em **Importar**.

## Backup

- No app: **Mais › Backup › Baixar backup** gera um JSON com tudo.
- No PC (com Docker), uma cópia diária do banco guardada por 14 dias, via cron:

  ```
  0 4 * * * cd /caminho/do/projeto && sh scripts/backup.sh >> backups/backup.log 2>&1
  ```

O GitHub Actions só testa o código e a imagem Docker a cada push. Ele não publica nada em servidor nenhum.

## Segurança

- Uma senha só, verificada com scrypt; depois de 5 erros o login espera cada vez mais.
- Sessão em cookie `HttpOnly`, `Secure` e `SameSite=Lax`, assinado com uma chave gerada no primeiro uso.
- Cabeçalhos de segurança (CSP sem scripts de terceiros, `X-Frame-Options: DENY`) e `noindex` para buscadores.
