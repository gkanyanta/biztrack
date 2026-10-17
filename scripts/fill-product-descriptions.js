#!/usr/bin/env node
// One-off: give Privtech's products a description and a brand where they have none, so they can
// go into the Meta (Facebook / WhatsApp) catalogue feed — which leaves out anything without a
// description, and would otherwise label a JBL headset with the store's own fallback brand.
//
// The text below says only what each product's name already tells us — type, capacity, model,
// size. No battery life, wattage or other spec is claimed that isn't in the name; add those by
// hand from the box if you want them.
//
// A brand is only set when the manufacturer's name is in the product's own name, and only one
// brand matches. Anything else keeps the store fallback and is listed.
//
// Safe by default: prints the plan and changes nothing without --apply. It only ever fills a
// blank description or brand — one already typed in is never replaced — and every run that
// applies writes a rollback file first.
//
// Usage:
//   node scripts/fill-product-descriptions.js --env=<path> --company=privtech-solutions
//   node scripts/fill-product-descriptions.js --env=<path> --company=privtech-solutions --apply
//   node scripts/fill-product-descriptions.js --env=<path> --rollback=<file>

const path = require('path');
const fs = require('fs');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
if (args.env) require('dotenv').config({ path: path.resolve(args.env) });
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Pass --env=<path to a .env file> or export it.');
  process.exit(1);
}
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Keyed by product id, so a renamed product still gets the right text and another company's
// product can never match.
const DESCRIPTIONS = {
  // 20000 mAh COYE CB-2 Fast Charging Powerbank
  cmsjdrrr60001d5b5wucbfwht: 'A 20,000mAh power bank from COYE with fast charging, enough to top up a phone several times over. A handy backup for travel, long days out and power cuts.',
  // Bopai Industrial Blower
  cmpyl7pa00005132cxszmipfo: 'A heavy-duty Bopai hair blow dryer built for salon-style drying and styling. Suited to everyday use at home as well as in a salon.',
  // BP Machine AK-9
  cmue8373e0001ludpjuvcrbls: 'The AK-9 digital blood pressure monitor for checking your blood pressure at home. Easy to use and a simple way to keep track of your readings between clinic visits.',
  // BP Machine Small
  cmue84q890001d3tc8trxi4po: 'A compact digital blood pressure monitor for checking your blood pressure at home or on the go. Small enough to keep in a drawer or a bag.',
  // Deep Rolling Massager
  cmor7af6e0001clsgm7twxh18: 'A rolling massager for working deep into tired, tight muscles. Use it on the back, shoulders, legs and feet after exercise or a long day.',
  // Hair Serum 100ml
  cmore712i00012xgdawdjnt2d: 'A 100ml hair serum for smoother, shinier, more manageable hair. Apply a small amount to damp or dry hair and style as usual.',
  // Itel 20000mAh Powerbank - Star 200c
  cmsje2okg0001p75rudjuaowa: 'The Itel Star 200c power bank with 20,000mAh capacity, enough to charge a phone several times. A reliable backup for travel and load-shedding.',
  // Itel Electric Kettle 1.8L
  cmtxdr90f000dqyuc7wmbtx3b: 'A 1.8 litre electric kettle from Itel for boiling water quickly for tea, coffee and cooking. Big enough for the whole household.',
  // Itel Fit 020 Smart Watch
  cmpo0s84500015ja0xlvaiw0n: 'The Itel Fit 020 smartwatch, a lightweight everyday watch that pairs with your phone to help you keep an eye on your activity and stay connected.',
  // Itel Lonter Music Fan
  cmunzo3la0001cukoyes8jgil: 'The Itel Lonter music fan, a fan with built-in music playback, so you can keep cool and enjoy your music from one device.',
  // Itel Trimmer
  cmrkb6gu9000713u83onlkb9x: 'An Itel hair and beard trimmer for neat, quick grooming at home. Easy to handle for touch-ups, shaping and keeping a tidy look.',
  // Leather Duffel Bag
  cmqtsz8iw0001h2cwtbxkzzs8: 'A leather duffel bag with plenty of room for weekend trips, the gym or travel. Stylish and practical in one.',
  // Leather Suitcase Size 30
  cmqj4l4vv0001w81072lgara9: 'A size 30 leather suitcase for longer trips, with generous space for clothes and essentials. Classic leather styling that stands out at the airport.',
  // Leather Suitcase Size 31
  cmqj4p0x90005w810m4ruu19e: 'A size 31 leather suitcase, the larger choice for long trips and extended stays. Classic leather styling with room to pack everything you need.',
  // Massage Gun YX-720S
  cmo4i6otr000dxdl8jcx4zbbv: 'The YX-720S massage gun, a handheld percussion massager for relieving sore, tight muscles after workouts or long days on your feet.',
  // Pure Leather Lapie Bag
  cmqwdpedq0001hxjk8hxca4rs: 'A pure leather Lapie bag that combines a smart look with everyday practicality. A durable bag that pairs well with work and casual outfits.',
  // Solar Products (variant: LED Light)
  cmtoil5fg000eha6a9rynyi36: 'A solar-powered LED light that charges from the sun, giving you light without electricity bills. Useful for power cuts, outdoor areas and off-grid spaces.',
  // Type C to HDTV 8in1 adapter
  cmolzkrs000012vvsacqgkylu: 'An 8-in-1 USB Type-C adapter with HDMI output for connecting your laptop, tablet or phone to a TV or monitor, plus extra ports for your other accessories.',
  // Umate Steam Comb
  cmsf533j3000gdivd1m600lhd: 'The Umate steam comb, a heated straightening comb that uses steam to smooth hair while you comb. Gentle on hair and quick to use.',
  // Waer Hair Curler
  cmpteit5w0001zfi1sfiomapo: 'A Waer hair curler for creating curls and waves at home. Easy to use for everyday styling or special occasions.',
  // Waer Shavers 3 in 1
  cmsf4e4md000cdivde1fwsj2t: 'A Waer 3-in-1 shaver set that covers shaving, trimming and grooming with one handy kit.',
  // Water proof travel Duffel Bag
  cmqtt101y0005h2cwyq51a88o: 'A waterproof travel duffel bag that keeps your belongings dry in the rain. Light, roomy and ready for trips, the gym or the beach.',
  // Water Steam pod
  cmnu7k4cq0005kti6pqtf1qpy: 'A steam hair straightener that uses steam as it styles to leave hair smooth and sleek. Suitable for everyday straightening at home.',
};

// Products found blank by the first dry run, which aren't on the public store (mostly out of
// stock), so their ids weren't to hand. Matched by exact name within the company; a name matching
// more than one product is skipped and reported, never guessed between.
const DESCRIPTIONS_BY_NAME = {
  '10L Silvercrest Airfrier': 'A 10 litre SilverCrest air fryer for crispy, golden food with little or no oil. A roomy size for family meals.',
  'Silver Crest Air Frier 12L': 'A 12 litre SilverCrest air fryer, the large size for big families and batch cooking. Crispy results with little or no oil.',
  'Silver Crest Air Frier 8L': 'An 8 litre SilverCrest air fryer for healthier frying with little or no oil. A practical size for everyday family cooking.',
  'Calus X20 Pro Earbuds': 'The Calus X20 Pro wireless earbuds for music and calls on the go. Compact, light and easy to carry everywhere.',
  'Calus ZIP 30 Wireless Earbuds': 'The Calus ZIP 30 wireless earbuds for cable-free music and calls. Small enough to slip into a pocket.',
  'Clothes Steamer': 'A clothes steamer for removing creases from shirts, dresses and curtains quickly, without needing an ironing board.',
  'Cosmetic Mirror': 'A cosmetic mirror for makeup, skincare and grooming. A neat addition to a dressing table or bathroom.',
  'Electrical Vegetable Cutter': 'An electric vegetable cutter that chops and slices quickly, saving time and effort when preparing meals.',
  'Hair Serum 60ml': 'A 60ml hair serum for smoother, shinier, more manageable hair. A handy size for your bag or for trying it out.',
  'Hot Air Brush': 'A hot air brush that dries and styles in one step, for smooth, full-bodied hair at home.',
  'Hot Comb': 'A heated hot comb for straightening and smoothing hair, ideal for quick touch-ups at the roots and edges.',
  'Itel Fit 025 Smart Watch': 'The Itel Fit 025 smartwatch, a lightweight everyday watch that pairs with your phone to help you keep an eye on your activity and stay connected.',
  'Itel Smart Shaver': 'An Itel electric shaver for a quick, clean shave at home or while travelling.',
  'JBL J-260BT Wireless Headphones': 'The JBL J-260BT Bluetooth wireless headphones for music and calls without cables getting in the way.',
  'JBL PURE BASS BT HEADPHONES': 'JBL Pure Bass Bluetooth headphones for wireless listening with a deep, punchy sound.',
  'Kemei KM-773 Big Shaver': 'The Kemei KM-773 shaver, the larger model in the range, for a fast and comfortable shave.',
  'Kemei KM-776 Small Shaver': 'The Kemei KM-776 compact shaver, small enough to travel with, for quick and easy shaving.',
  'Kenwood Blender': 'A Kenwood blender for smoothies, soups, sauces and everyday blending in the kitchen.',
  'Silverest Pro Blender': 'The Silverest Pro blender for smoothies, juices, soups and everyday food preparation.',
  'Laichy Steampod': 'The Laichy steam hair straightener, which uses steam as it styles to leave hair smooth and sleek.',
  'Professional Steam Styler': 'A professional steam hair styler for smooth, sleek straightening with the help of steam.',
  'Leather Suitcase Set size 32"': 'A leather suitcase set in size 32 for long trips and family travel. Classic leather styling with plenty of packing space.',
  'Pure Leather Rong Run Travel Bag': 'A pure leather Rong Run travel bag, stylish and durable for weekend trips and business travel.',
  'Water Proof Gym Bag': 'A waterproof gym bag that keeps your kit and belongings dry. Light and easy to carry to the gym, sports or travel.',
  'MocoMax Industrial Hair Blower': 'A heavy-duty MocoMax hair blow dryer built for salon-style drying and styling, at home or in a salon.',
  'Oraimo Smart Watch 5 Max': 'The Oraimo Watch 5 Max smartwatch, which pairs with your phone to help you keep an eye on your activity and stay connected.',
  'Portable Vacum Cleaner': 'A portable vacuum cleaner for quick clean-ups around the home. Light and easy to carry from room to room.',
  'Pressure Washer': 'A pressure washer for cleaning cars, driveways, walls and outdoor surfaces with a powerful jet of water.',
  'Tripod Head Stand': 'A tripod stand that holds a mannequin head steady for braiding, styling and wig work.',
  'Silicon Dummy Head':'A silicone mannequin head for practising hairstyling and braiding, and for displaying wigs.',
  'Smart Fascia Massager JY-760': 'The JY-760 smart fascia massager, a handheld percussion massager for relieving sore, tight muscles after workouts or long days.',
  'Tornado Pots 14 piece set': 'A 14-piece Tornado pot set for everyday cooking, from small sauces to big family meals.',
  'TrendNet Crimping Tool': 'A TRENDnet crimping tool for fitting connectors onto network cables, for installing and repairing cabling.',
  'Waer Shaving Clipper': 'A Waer shaving clipper for trimming, shaping and keeping hair and beards neat at home.',
};

// Manufacturer names as they should appear in the catalogue, with the spellings they turn up as
// in product names.
const BRANDS = [
  ['itel', /\bitel\b/i], ['JBL', /\bjbl\b/i], ['Kemei', /\bkemei\b/i], ['Kenwood', /\bkenwood\b/i],
  ['Oraimo', /\boraimo\b/i], ['SilverCrest', /\bsilver\s?crest\b/i], ['TRENDnet', /\btrend\s?net\b/i],
  ['Calus', /\bcalus\b/i], ['COYE', /\bcoye\b/i], ['Waer', /\bwaer\b/i], ['Bopai', /\bbopai\b/i],
  ['MocoMax', /\bmoco\s?max\b/i], ['Umate', /\bumate\b/i], ['Laichy', /\blaichy\b/i],
  ['Tornado', /\btornado\b/i], ['Rong Run', /\brong\s?run\b/i],
];
const blank = v => !(v || '').trim();

(async () => {
  if (args.rollback) {
    const saved = JSON.parse(fs.readFileSync(path.resolve(args.rollback), 'utf8'));
    for (const r of saved.rows) {
      const data = {};
      if ('description' in r) data.description = r.description;
      if ('brand' in r) data.brand = r.brand;
      await prisma.product.updateMany({ where: { id: r.id, companyId: saved.companyId }, data });
    }
    console.log(`Restored ${saved.rows.length} products from ${args.rollback}.`);
    return;
  }
  if (!args.company) { console.error('--company=<slug> is required.'); process.exit(1); }
  const company = await prisma.company.findUnique({ where: { slug: args.company } });
  if (!company) { console.error(`No company with slug "${args.company}".`); process.exit(1); }

  const products = await prisma.product.findMany({
    where: { companyId: company.id, isActive: true },
    select: { id: true, name: true, variantLabel: true, description: true, brand: true, stock: true },
    orderBy: { name: 'asc' },
  });
  const nameCount = {};
  products.forEach(p => { nameCount[p.name] = (nameCount[p.name] || 0) + 1; });
  const describe = p => DESCRIPTIONS[p.id] || (nameCount[p.name] === 1 ? DESCRIPTIONS_BY_NAME[p.name] : undefined);
  const label = p => `${p.name}${p.variantLabel ? ` (${p.variantLabel})` : ''}`;

  // ---- descriptions ----
  const descFill = products.filter(p => blank(p.description) && describe(p));
  console.log('DESCRIPTIONS');
  for (const p of descFill) console.log(`fill   ${label(p)}\n       ${describe(p)}`);
  for (const [name, n] of Object.entries(nameCount)) if (n > 1 && DESCRIPTIONS_BY_NAME[name]) console.log(`ambig  ${name} (${n} products share this name; skipped)`);
  const descLeft = products.filter(p => blank(p.description) && !describe(p));
  if (descLeft.length) {
    console.log(`\n${descLeft.length} active products are still without a description:`);
    for (const p of descLeft) console.log(`       ${label(p)}  stock ${p.stock}`);
  }

  // ---- brands ----
  const brandFill = [];
  const unbranded = [];
  for (const p of products) {
    if (!blank(p.brand)) continue;
    const hits = BRANDS.filter(([, re]) => re.test(p.name)).map(([b]) => b);
    if (hits.length === 1) brandFill.push({ p, brand: hits[0] });
    else unbranded.push({ p, hits });
  }
  console.log('\nBRANDS');
  for (const { p, brand } of brandFill) console.log(`brand  ${brand.padEnd(12)} ${label(p)}`);
  console.log(`\n${unbranded.length} products have no brand in their name and will use the store fallback:`);
  for (const { p, hits } of unbranded) console.log(`       ${label(p)}${hits.length > 1 ? `  (matches ${hits.join(' and ')}; skipped)` : ''}`);

  if (!args.apply) { console.log(`\nDry run: ${descFill.length} descriptions and ${brandFill.length} brands would be filled. Re-run with --apply to write.`); return; }

  const rows = new Map();
  for (const p of descFill) rows.set(p.id, { id: p.id, description: p.description });
  for (const { p } of brandFill) rows.set(p.id, { ...(rows.get(p.id) || { id: p.id }), brand: p.brand });
  const file = path.resolve(`descriptions-rollback-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ companyId: company.id, rows: [...rows.values()] }, null, 2));
  // Each write re-checks that the field is still blank, so nothing typed in since the dry run is replaced.
  for (const p of descFill) {
    await prisma.product.updateMany({ where: { id: p.id, companyId: company.id, OR: [{ description: null }, { description: '' }] }, data: { description: describe(p) } });
  }
  for (const { p, brand } of brandFill) {
    await prisma.product.updateMany({ where: { id: p.id, companyId: company.id, OR: [{ brand: null }, { brand: '' }] }, data: { brand } });
  }
  console.log(`\nFilled ${descFill.length} descriptions and ${brandFill.length} brands. Rollback file: ${file}`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
