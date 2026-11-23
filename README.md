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

## Extratos direto do Gmail

O app confere o Gmail a cada 30 minutos e traz os anexos OFX, CSV ou PDF:

- dos remetentes cadastrados em **Mais › Ajustes** (por padrão, o Nubank: `todomundo@nubank.com.br`);
- dos e-mails que **você manda para você mesmo** com o arquivo anexo. Isso serve para faturas do Santander e da Caixa: encaminhe ou envie o PDF para o seu próprio e-mail.

Eles aparecem em **Importar › Chegaram por e-mail**, prontos para conferir e confirmar. Nada é lançado sem você confirmar. O app só lê os e-mails: não apaga e não marca nada como lido.

Para ligar:

1. A conta Google precisa ter a **verificação em duas etapas** ativa.
2. Crie uma **senha de app** em <https://myaccount.google.com/apppasswords> (nome: "Finanças"). O Google mostra 16 letras.
3. No `.env`, preencha `GMAIL_EMAIL` com o seu e-mail e `GMAIL_SENHA_APP` com essas 16 letras (com ou sem espaços).
4. Rode `docker compose up -d`. Em **Importar**, use **Buscar agora** para testar.

Faturas em PDF com senha: cadastre a senha em **Mais › Ajustes › Senhas de PDF**.

## Avisos no celular

Em **Mais › Ajustes › Ligar avisos neste aparelho** (com o app aberto pelo endereço `https://…ts.net`). Chegam:

- às 9h, as contas que vencem em até 2 dias ou estão atrasadas;
- quando chega um extrato novo pelo Gmail;
- no dia 1, o resumo do mês que fechou.

No iPhone, os avisos só funcionam com o app instalado na tela de início.

## Backup

- **Automático:** todo dia às 3h o app grava na pasta `backups` do projeto um JSON (que pode ser restaurado no app) e uma cópia do banco. Ficam os últimos 30 dias. Também dá para baixar pela tela **Mais › Backup**.
- **Na nuvem:** preencha `PASTA_BACKUP_NUVEM` no `.env` com uma pasta sincronizada (por exemplo, uma pasta do Google Drive para computador). O script de atualização automática copia os backups para lá.
- **Manual:** **Mais › Backup › Baixar backup**.

## Atualização automática

Uma tarefa confere o GitHub a cada 10 minutos. Quando há versão nova **que passou nos testes**, ela faz um backup, atualiza e confere se o app voltou. Se não voltar, retorna sozinha para a versão anterior e não tenta mais aquela versão. Ela também sobe o app se ele estiver parado, por exemplo depois de reiniciar o PC.

Para ligar, uma vez, **no terminal do Ubuntu (WSL)**, dentro da pasta do projeto:

```bash
cd ~/workspace/gestao-financeira      # a pasta onde está o projeto
bash scripts/instalar-atualizacao.sh
```

- **No Windows com WSL:** cria a tarefa "Financas - atualizar" no Agendador de Tarefas do Windows. Ela chama o script dentro do Ubuntu sem abrir janela e funciona com o terminal fechado. No Docker Desktop, deixe ligados **Start Docker Desktop when you sign in** e a integração com o Ubuntu (**Settings › Resources › WSL integration**).
- **Em um Linux comum:** usa o cron.

O que a tarefa fez fica em `logs/atualizar.log`. Para desligar: `bash scripts/desinstalar-atualizacao.sh`.

Para a cópia na nuvem (`PASTA_BACKUP_NUVEM`), use o caminho da pasta como o Ubuntu a vê, por exemplo `/mnt/c/Users/SEU_USUARIO/Google Drive/Financas`.

## Segurança

- Uma senha só, verificada com scrypt; depois de 5 erros o login espera cada vez mais.
- Sessão em cookie `HttpOnly`, `Secure` e `SameSite=Lax`, assinado com uma chave gerada no primeiro uso.
- Cabeçalhos de segurança (CSP sem scripts de terceiros, `X-Frame-Options: DENY`) e `noindex` para buscadores.
