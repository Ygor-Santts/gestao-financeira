// Gmail import, phone notifications and reminders, with made-up data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createECDH, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { parseMail, decodeWords } from '../server/mail/mime.js';
import { Imap } from '../server/mail/imap.js';
import { initMail, checkMail, buildQuery, pickAttachment } from '../server/mail/index.js';
import { encrypt } from '../server/push/webpush.js';
import { openDb } from '../server/db.js';
import { billReminder, monthSummary } from '../server/jobs.js';

const OFX = 'OFXHEADER:100\n<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>NU PAGAMENTOS S.A.</FI></SONRS></SIGNONMSGSRSV1><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0260<ACCTID>1</BANKACCTFROM><BANKTRANLIST>'
  + '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261120<TRNAMT>-10.00<FITID>z1<MEMO>Compra no débito - PADARIA</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n';

function mail() {
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
  return [
    'From: =?UTF-8?Q?Nubank?= <todomundo@nubank.com.br>',
    'Subject: =?UTF-8?B?RXh0cmF0byBkYSBzdWEgY29udGE=?=',
    'Date: Fri, 20 Nov 2026 10:00:00 -0300',
    'Content-Type: multipart/mixed; boundary="outer"',
    '', '--outer',
    'Content-Type: multipart/alternative; boundary=inner',
    '', '--inner', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Ol=C3=A1, Ygor', '--inner--',
    '--outer',
    'Content-Type: application/pdf; name="extrato.pdf"', 'Content-Disposition: attachment; filename="extrato.pdf"', 'Content-Transfer-Encoding: base64', '', b64('%PDF-1.4 fake'),
    '--outer',
    'Content-Type: application/octet-stream', "Content-Disposition: attachment; filename*=utf-8''NU_123_01NOV2026_20NOV2026%20(c%C3%B3pia).ofx", 'Content-Transfer-Encoding: base64', '', b64(OFX),
    '--outer--', '',
  ].join('\r\n');
}

test('MIME: subject, sender and attachments (base64, RFC 2231 names)', () => {
  const m = parseMail(Buffer.from(mail(), 'latin1'));
  assert.equal(m.subject, 'Extrato da sua conta');
  assert.match(m.from, /todomundo@nubank\.com\.br/);
  assert.deepEqual(m.attachments.map((a) => a.filename), ['extrato.pdf', 'NU_123_01NOV2026_20NOV2026 (cópia).ofx']);
  assert.equal(m.attachments[1].data.toString(), OFX);
  assert.equal(pickAttachment(m.attachments).filename.endsWith('.ofx'), true);
  assert.equal(decodeWords('=?iso-8859-1?Q?Fatura_Cart=E3o?='), 'Fatura Cartão');
});

test('Gmail search query keeps own e-mails limited to the ones sent to yourself', () => {
  assert.equal(buildQuery(['todomundo@nubank.com.br', 'me'], 45),
    'has:attachment newer_than:45d {filename:ofx filename:csv filename:pdf} (from:todomundo@nubank.com.br OR (from:me to:me))');
});

// A fake IMAP server speaking just enough of the protocol, Gmail style.
function fakeImap(raw) {
  const server = net.createServer((s) => {
    s.write('* OK Gimap ready\r\n');
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        if (/^LOGIN "a@b\.com" "senhadeapp"$/.test(cmd)) s.write(`${tag} OK logged in\r\n`);
        else if (cmd.startsWith('LOGIN')) s.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        else if (cmd.startsWith('LIST')) s.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\All \\HasNoChildren) "/" "[Gmail]/Todos os e-mails"\r\n${tag} OK\r\n`);
        else if (cmd === 'EXAMINE "[Gmail]/Todos os e-mails"') s.write(`* 3 EXISTS\r\n${tag} OK [READ-ONLY]\r\n`);
        else if (cmd.startsWith('UID SEARCH X-GM-RAW')) s.write(`* SEARCH 7\r\n${tag} OK\r\n`);
        else if (cmd.startsWith('UID FETCH 7')) {
          const body = Buffer.from(raw, 'latin1');
          s.write(`* 3 FETCH (UID 7 X-GM-MSGID 1777 BODY[] {${body.length}}\r\n`);
          s.write(body);
          s.write(`)\r\n${tag} OK\r\n`);
        } else if (cmd === 'LOGOUT') { s.write(`* BYE\r\n${tag} OK\r\n`); s.end(); }
        else s.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('Gmail: new statement lands in the inbox once, with its count of new lines', async () => {
  const server = await fakeImap(mail());
  const port = server.address().port;
  process.env.GMAIL_EMAIL = 'a@b.com';
  process.env.GMAIL_SENHA_APP = 'senh adea pp'; // Google shows app passwords with spaces
  const db = openDb(':memory:');
  initMail(db);
  const factory = () => new Imap({ connect: () => net.connect(port, '127.0.0.1') });
  const r = await checkMail(db, { imapFactory: factory });
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].novos, 1);
  const again = await checkMail(db, { imapFactory: factory });
  assert.equal(again.added.length, 0);
  const row = db.prepare('SELECT filename, status FROM inbox').get();
  assert.equal(row.status, 'novo');
  assert.match(row.filename, /\.ofx$/);

  process.env.GMAIL_SENHA_APP = 'errada';
  db.exec('DELETE FROM mail_seen');
  await assert.rejects(checkMail(db, { imapFactory: factory }), /recusou o login/);
  server.close();
});

test('push payload decrypts on the browser side (RFC 8291)', () => {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint: 'https://push.example/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const body = encrypt('{"title":"Oi"}', sub);
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(plain.subarray(0, -1).toString(), '{"title":"Oi"}');
  assert.equal(plain.at(-1), 2);
});

test('reminders: due soon, late, and the month summary', () => {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO bills (month, description, amount, due, paid) VALUES (?, ?, ?, ?, ?)');
  ins.run('2026-11', 'Cartão Caixa', 2453.92, '2026-11-24', 0);
  ins.run('2026-11', 'Luz', 100, '2026-11-20', 0);
  ins.run('2026-11', 'Paga', 50, '2026-11-23', 1);
  ins.run('2026-11', 'Longe', 50, '2026-11-30', 0);
  const r = billReminder(db, '2026-11-23');
  assert.equal(r.title, '1 conta atrasada');
  assert.match(r.body, /Luz: R\$\s100,00 \(atrasada\)/);
  assert.match(r.body, /Cartão Caixa: R\$\s2\.453,92 \(amanhã\)/);
  assert.doesNotMatch(r.body, /Longe|Paga/);
  assert.equal(billReminder(db, '2026-12-05'), null);

  const t = db.prepare("INSERT INTO transactions (date, description, amount, type) VALUES (?, 'x', ?, ?)");
  t.run('2026-10-05', 1000, 'entrada'); t.run('2026-10-06', -1500, 'saida'); t.run('2026-10-07', 400, 'investimento');
  const s = monthSummary(db, '2026-10');
  assert.match(s.title, /^Outubro fechou gastando R\$\s500,00 a mais/);
  assert.match(s.body, /Tirou R\$\s400,00 das caixinhas/);
});
