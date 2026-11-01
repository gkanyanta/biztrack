# ZRA Smart Invoice

BizTrack can report a company's sales to the Zambia Revenue Authority (ZRA) through Smart Invoice.
It is **off for every company** until the BizTrack superadmin switches it on for that company. While
it is off, BizTrack behaves exactly as before and never contacts ZRA.

```
BizTrack sale (Confirmed) → company's VSDC → ZRA
                          ← receipt no., signature, QR ← (printed on the receipt)
```

The **VSDC** (Virtual Sales Data Controller) is ZRA's Java service. It sits between a business system
and ZRA and holds the device's keys. BizTrack runs on Vercel and cannot host it, so each company
needs a VSDC running somewhere BizTrack can reach over HTTPS (a small always-on server is enough).
Ask ZRA whether one VSDC can serve several TPINs, or whether each company needs its own.

## What happens to a sale

| Event | What BizTrack does |
|---|---|
| Sale saved as Confirmed, Shipped or Delivered (or moved to one of those) | Writes an invoice record in the same database transaction, then sends it to the VSDC straight away |
| VSDC unreachable or times out (8 s) | The sale is saved anyway. The invoice waits and is retried automatically after later sales, or with **Send everything waiting** |
| ZRA refuses it, or something must be fixed first (e.g. a product with no classification code) | The sale is saved. The invoice is marked **Need fixing** with the reason, and is only retried when someone presses a retry button |
| Sale cancelled after it was invoiced | A credit note is sent that points at the original ZRA receipt. A credit note is recorded even if Smart Invoice has since been switched off, because ZRA still holds the invoice |
| Sale is still Pending | Nothing is sent |
| Sale dated before the **Report sales from** date | Never sent |

Once a sale has a ZRA invoice:

- Its items, prices, discount, delivery charge and date can't be changed. Cancel it, which sends a credit note, and record it again.
- It can't go back to Pending and can't be deleted.
- After a credit note it can't be revived.

Notes, payment status and contact details can still change.

The invoice number sent to ZRA is BizTrack's order number (e.g. `ORD-0123`), and the credit note's
is the order number with `-CN` added. Delivery charges go to ZRA as a separate `DELIVERY` line. A
sale-wide discount is shared across the lines by value, so the lines always add up to the total
the customer paid.

## Turnover tax (Privtech)

A turnover-tax business uses the tax category **TOT**. The invoice reports the whole sale as TOT
turnover with **no tax added to the customer's price**. Turnover tax is paid by the business on its
turnover through its returns, not charged on the invoice. VAT-registered companies use **A**
(16% VAT included in the price) instead.

## Setting a company up

The superadmin does this under **Superadmin → company → ZRA Smart Invoice**.

1. Get from ZRA: Smart Invoice registration for the company, the VSDC installed and its address,
   the **TPIN**, the **branch ID** (`000` for head office), and the **device serial number**.
2. On the server, add the VSDC's host name to the `ZRA_ALLOWED_HOSTS` environment variable in
   Vercel (comma-separated, e.g. `vsdc.privtech.net`), then redeploy. BizTrack will not call any host
   that isn't listed there. This protects the server from being pointed at anything else.
3. Fill in:
   - environment (start with **Sandbox**)
   - VSDC address, TPIN, branch ID and device serial
   - default tax category (TOT for Privtech)
   - **Report sales from**: the first day to report
   - **Goods made in**: the two-letter country code, e.g. `CN`
   - the delivery classification code
   - the credit note reason code
4. **Save**, then **Initialise device**. This is ZRA's one-time handshake, and it also tests the
   connection.
5. Each company admin adds the **ZRA item classification code** to every product it sells
   (Products → edit), plus a tax category if one differs from the company default. **Settings → ZRA
   Smart Invoice** shows how many active products are still missing one.
6. **Switch on.** BizTrack refuses to switch on until everything above is filled in and the
   device has been initialised.

Changing the VSDC address, TPIN, branch or device serial switches Smart Invoice off. Initialise
again, and every product is registered with ZRA afresh before its next sale.

## Day to day

- **Sales list:** each sale shows a tag: `ZRA ✓`, `ZRA pending`, `ZRA failed` or `ZRA credited`.
  The sale's detail shows the ZRA receipt number, or the reason it hasn't gone through.
- **Receipts:** an accepted sale's PDF receipt carries the ZRA QR code, invoice and receipt
  numbers, SDC ID, MRC number, internal data and signature. A sale ZRA hasn't accepted yet says so
  on the receipt.
- **Settings → ZRA Smart Invoice:** counts of issued, waiting and need-fixing documents, each
  problem with its reason, and retry buttons.

## Before going live: confirm in the sandbox

BizTrack follows ZRA's VSDC API specification v1.0.7 and its published sample requests. Confirm
these against the sandbox, because they come from code lists BizTrack could not check against a
real VSDC:

- **Payment type codes** sent as `pmtTyCd`: cash `01`, credit `02`, card `05`, mobile money `06`
  (including Lenco online payments), bank transfer `07`. These are in `ZRA_PAYMENT_CODES`, in
  `server/src/utils/zra.js` and `api/index.js`.
- **Quantity and packaging unit codes:** default `U` and `NT`, editable per company.
- **The credit note reason code:** no default, so set it from ZRA's list.
- **How the VSDC reports the TOT lines:** BizTrack sends `vatCatCd: "TOT"`, the turnover in
  `taxblAmtTot`, and zero tax.
- **What the VSDC returns:** BizTrack reads `rcptNo`, `intrlData`, `rcptSign`, `vsdcRcptPbctDate`,
  `sdcId`, `mrcNo` and `qrCodeUrl` from `data`.

Run a few sales, a cancellation and an offline period in the sandbox. Check each one in ZRA's
portal before switching the environment to Production.

## Not covered yet

- Customer TPINs on invoices (needed by VAT-registered buyers claiming input VAT)
- Partial returns (BizTrack cancels whole sales only)
- Debit notes
- Purchases and stock reporting to ZRA
- Export sales

## Rollback

Switching Smart Invoice off for a company stops all ZRA traffic for it at once. Nothing else
changes.

To remove the feature entirely, revert the commit. Its migration only adds the `ZraConfig` and
`FiscalDocument` tables and three nullable product columns, so leaving them in place is harmless.
