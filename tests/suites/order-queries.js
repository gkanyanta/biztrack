// The office asking a consultant what is happening with an order, and the consultant answering.
const { loginAs } = require('../lib/harness');

module.exports = {
  name: 'Order queries',
  seed: 'orderqueries',
  async run({ base, seed, t }) {
    const { eq, section } = t;
    const [boss, annie, evelyn, bea, otherboss] = await Promise.all(['boss', 'annie', 'evelyn', 'bea', 'otherboss'].map(u => loginAs(base, u)));
    const today = new Date().toISOString().slice(0, 10);

    section('the sales report shows every note and whose turn it is');
    const report = (await boss('GET', `/sales/reports/daily?from=${today}&to=${today}`)).body;
    const a1 = report.orders.find(o => o.orderNumber === 'ORD-A1');
    eq('all the notes on an order, newest first', a1.notes.map(n => n.note), ['Balance promised Friday', 'Paid K100 on delivery']);
    eq('with what is still owed', a1.balance, 200);
    eq('and no query yet', a1.query, null);

    section('asking');
    const asked = await boss('POST', '/order-queries', { saleId: seed.annieSaleId, message: 'Has the customer paid the balance?' });
    eq('the office can ask about an order', [asked.status, asked.body.status, asked.body.consultant.name], [201, 'open', 'Annie']);
    eq('the question carries who asked', [asked.body.messages[0].authorName, asked.body.messages[0].authorRole], ['Gerald', 'admin']);
    eq('and the order it is about', [asked.body.order.orderNumber, asked.body.order.balance], ['ORD-A1', 200]);
    const again = await boss('POST', '/order-queries', { saleId: seed.annieSaleId, message: 'Any news?' });
    eq('asking again adds to the same thread rather than starting another', [again.body.id, again.body.messages.length], [asked.body.id, 2]);
    eq('an empty question is refused', (await boss('POST', '/order-queries', { saleId: seed.evelynSaleId, message: '  ' })).status, 400);
    eq('an order with no consultant cannot be queried', (await boss('POST', '/order-queries', { saleId: seed.directSaleId, message: 'x' })).status, 400);
    eq("another company's order is not found", (await boss('POST', '/order-queries', { saleId: seed.otherSaleId, message: 'x' })).status, 404);
    eq('a consultant cannot raise a query', (await annie('POST', '/order-queries', { saleId: seed.annieSaleId, message: 'x' })).status, 403);
    eq('nor can the inventory clerk read them', (await bea('GET', '/order-queries')).status, 403);
    const eAsked = await boss('POST', '/order-queries', { saleId: seed.evelynSaleId, message: 'Was this delivered?' });

    section('the consultant sees only her own, and that it waits on her');
    eq('Annie sees the query on her order', (await annie('GET', '/order-queries')).body.map(q => q.order.orderNumber), ['ORD-A1']);
    eq('and is told one waits on her', (await annie('GET', '/order-queries/summary')).body, { waitingOnYou: 1, waitingOnThem: 0 });
    eq("she cannot answer Evelyn's", (await annie('POST', `/order-queries/${eAsked.body.id}/messages`, { message: 'x' })).status, 404);
    eq("another company's admin sees none of it", (await otherboss('GET', '/order-queries')).body, []);
    eq('the office sees two waiting on consultants', (await boss('GET', '/order-queries/summary')).body, { waitingOnYou: 0, waitingOnThem: 2 });
    const r2 = (await boss('GET', `/sales/reports/daily?from=${today}&to=${today}`)).body.orders.find(o => o.orderNumber === 'ORD-A1');
    eq('the report shows the open query', r2.query.status, 'open');

    section('answering');
    const replied = await annie('POST', `/order-queries/${asked.body.id}/messages`, { message: 'She pays the K200 on Friday' });
    eq('her answer hands the turn back to the office', [replied.status, replied.body.status, replied.body.lastMessage.authorName], [200, 'answered', 'Annie']);
    eq('the office sees an answer waiting', (await boss('GET', '/order-queries/summary')).body, { waitingOnYou: 1, waitingOnThem: 1 });
    eq('and can list only those', (await boss('GET', '/order-queries?status=answered')).body.map(q => q.id), [asked.body.id]);
    const back = await boss('POST', `/order-queries/${asked.body.id}/messages`, { message: 'Please confirm once paid' });
    eq('a reply from the office puts it back with her', back.body.status, 'open');

    section('closing');
    const closed = await boss('POST', `/order-queries/${asked.body.id}/close`);
    eq('the office can close it', [closed.status, closed.body.status, !!closed.body.closedAt], [200, 'closed', true]);
    eq('she can no longer write on it', (await annie('POST', `/order-queries/${asked.body.id}/messages`, { message: 'x' })).status, 400);
    eq('nor close one herself', (await evelyn('POST', `/order-queries/${eAsked.body.id}/close`)).status, 403);
    eq('closed threads are out of the active list', (await annie('GET', '/order-queries')).body, []);
    eq('but can still be read', (await annie('GET', '/order-queries?status=closed')).body[0].messages.length, 4);
    const reopened = await boss('POST', '/order-queries', { saleId: seed.annieSaleId, message: 'Still not paid?' });
    eq('asking about the order again starts a fresh thread', [reopened.body.id !== asked.body.id, reopened.body.messages.length], [true, 1]);
  },
};
