# Facebook & WhatsApp catalogue (Meta feed)

BizTrack publishes the online store's products as a CSV feed. Meta Commerce Manager fetches it on a
schedule, so products are managed once in BizTrack and the Facebook and WhatsApp catalogues follow.

```
BizTrack products → feed URL → Meta Commerce Manager (scheduled fetch) → Facebook Shop / WhatsApp
```

Privtech's feed URL:

```
https://store.privtech.net/api/v1/store/privtech-solutions/meta-feed.csv
```

The store slug is `privtech-solutions`. If you set a feed access token, the URL ends in
`?token=…`. **Settings → Facebook & WhatsApp Catalogue** always shows the exact URL to paste into
Meta.

## What goes into the feed

| Meta field | Where it comes from |
|---|---|
| `id` | The product's BizTrack ID. It never changes, even if the SKU or name does. |
| `title` | Product name, plus the variant label (e.g. `T-Shirt - Red`) unless the name already includes it |
| `description` | Product description as plain text (tags and line breaks removed) |
| `availability` | `in stock` if stock > 0, otherwise `out of stock` |
| `condition` | Always `new` |
| `price` | Selling price, e.g. `1500.00 ZMW`. If the product has an original price higher than the selling price, `price` is the original price. |
| `sale_price` | The selling price, only when there is a higher original price |
| `link` | `https://store.privtech.net/?product=<id>`. The store scrolls to that product and selects the variant. |
| `image_link` | The public product-image URL, with `?v=<last updated>` so Meta re-downloads an image after it changes |
| `brand` | The product's **Brand** field, or the store's **Fallback brand** if that is blank |
| `product_type` | The BizTrack category |
| `item_group_id` | The product group, so colour and size variants appear as one item on Facebook |

**Included:** every active product, including out-of-stock ones (they show as sold out).
**Not included:** inactive products. Meta removes anything that disappears from a scheduled feed.

**Left out, with the reason shown in Settings**, because Meta would reject them and we don't invent
data:

- no image
- an image that is not JPEG or PNG (Meta's requirement)
- no description
- no brand and no fallback brand
- a selling price of zero

**Never in the feed:** cost price, supplier, reorder level, sales, or any customer data.

## One-time BizTrack setup

1. **Settings → Facebook & WhatsApp Catalogue**
   - Tick **Publish the catalogue feed**.
   - Set a **Fallback brand**, e.g. `Privtech`. Use it for unbranded goods you sell under your own name.
   - Optionally set a **Feed access token**. It isn't essential: the feed only contains what the
     public store already shows.
   - Save. The same card shows how many products are in the feed and lists any left out, with reasons.
2. For genuinely branded products (e.g. Hisense, Samsung), open the product and fill in **Brand**.
   Meta uses brand for matching and policy checks, so don't put the store name on another company's product.
3. Fix whatever the "left out" list shows: add a description, upload a JPEG/PNG photo, and so on.

## Meta Commerce Manager

Meta's screens change often. The steps below describe the flow; the button names may differ slightly.

### 1. Create the catalogue
1. Go to <https://business.facebook.com/commerce> using the Meta Business portfolio that owns
   Privtech's Facebook Page (and the WhatsApp Business number, if you'll connect WhatsApp).
2. **Create a catalogue** → type **Ecommerce** (online products) → **Upload product info**
   (not a partner platform) → choose the Privtech business portfolio → name it, e.g. "Privtech Store".

### 2. Add the scheduled feed
1. In the catalogue: **Catalogue → Data sources → Add items → Data feed** (sometimes "Scheduled feed").
2. Choose **Use a URL** and paste the feed URL from BizTrack Settings.
3. Leave login details blank (the token, if you set one, is already in the URL).
4. Schedule: **Hourly** if offered, otherwise **Daily**. BizTrack lets the CDN reuse a fetch for up to
   15 minutes, so an hourly fetch picks up changes within about an hour and a quarter.
5. Currency: **ZMW**. Upload. The first fetch takes a few minutes.

### 3. Connect the catalogue to the Facebook Page
- **Commerce Manager → Sales channels** (or "Shops") → add **Facebook Page** → choose Privtech's
  Page and this catalogue. A Shop must be approved by Meta, and is only available in some countries.
  If Shops aren't available in Zambia, you can still use the catalogue for product tagging in posts
  and for catalogue ads.

### 4. Connect WhatsApp (separate step: it doesn't happen automatically)
Having a Meta catalogue doesn't put products on WhatsApp. Connect it explicitly:
- **WhatsApp Business app:** the number has to be linked to the same business portfolio or Facebook
  Page. Then, in the app, go to **Business tools → Catalogue** and choose the option to use or connect
  the Facebook/Commerce Manager catalogue. If you only see a way to add items by hand, the number
  isn't linked to the portfolio that owns the catalogue yet.
- **WhatsApp Business Platform (API) / WhatsApp Manager:** **WhatsApp Manager → Catalogue → Choose a
  catalogue**, then pick "Privtech Store".
- Meta can refuse items on WhatsApp under its commerce policies even if they're accepted in the
  catalogue, so check the WhatsApp catalogue view after connecting.

### 5. Reviewing rejected items and sync errors
- **Commerce Manager → Catalogue → Issues** lists items Meta rejected or warned about, and why.
  Common reasons include images smaller than 500×500 (BizTrack can't check pixel size) and policy flags.
- **Data sources → (your feed)** shows each fetch: when it ran, how many items were added or updated,
  and errors. A fetch that BizTrack answered with an error appears here as a failed fetch, and **the
  existing catalogue is kept**.
- BizTrack's own list of products it left out is in **Settings → Facebook & WhatsApp Catalogue**.

### 6. Testing an update
1. In BizTrack, change one product's price (or stock to 0).
2. Open the feed URL in a browser and find that product's row. The change appears within 15 minutes.
3. In Commerce Manager → Data sources → your feed → **Request update** (fetch now).
4. Check the item under **Catalogue → Items**: the price or availability should match.
5. Change the product back.

## Safety behaviour

| Situation | Feed answers | Effect on Meta |
|---|---|---|
| Normal | `200` CSV, CDN-cached 15 min | Catalogue updated |
| Database error | `503`, not cached, `Retry-After: 600` | Fetch fails; catalogue kept as it was |
| No product is publishable | `503`, `Retry-After: 3600` | Fetch fails; catalogue kept. BizTrack will never publish an empty feed that would wipe the catalogue. To empty the catalogue on purpose, delete items in Commerce Manager. |
| Feed switched off, wrong token, unknown or deactivated store | `404` | Fetch fails |

Each fetch writes one JSON log line (`"event":"meta_feed"`) with the outcome, row counts and
timing. It's visible in Vercel → Logs.

## Deployment

The change is additive:

- one new nullable column, `Product.brand` (migration `20261017100000_product_brand`, in both
  `prisma/` and `server/prisma/`)
- one new public `GET` route (the feed), one admin `GET` route (the report)
- a Brand field, a Settings card, and `?product=` deep links in the store

Checkout, payment and order routes are untouched.

1. Merge the PR into `main`. Vercel's build runs `prisma migrate deploy`, which adds the column.
2. After the deploy goes live, open Settings, switch the feed on, and set the fallback brand.
3. Open the feed URL in a browser to check it, then set up Commerce Manager as above.

The feed is off for every company until an admin switches it on, so deploying alone publishes nothing.

## Rollback

- **Fastest:** in Settings, untick **Publish the catalogue feed**. The URL returns 404 immediately,
  and Meta keeps the last good catalogue. Pause the schedule in Commerce Manager if you want.
- **Code:** in Vercel, promote the previous production deployment, or revert the merge commit. The
  `brand` column can stay: it's nullable and older code ignores it. If it really must go:
  `ALTER TABLE "Product" DROP COLUMN "brand";` and delete the migration row from
  `_prisma_migrations`. This isn't needed for a rollback.
