import { beforeEach, describe, expect, it } from 'vitest';
import { createShop, request, resetWorld, type TestShop } from './helpers';
import { nameSkeleton, parseTranscriptLocally } from '../src/services/localParser';
import { ExtractedTransactionSchema, TransactionDraftSchema } from '../src/schemas/ai';
import { products } from '../src/services/repository';
import { nowIso } from '../src/utils/dates';
import { newProductId } from '../src/utils/ids';

/**
 * Voice capture.
 *
 * Two layers are tested separately because they fail differently. The parser is
 * tested on language — does it understand how a shopkeeper actually speaks. The
 * route is tested on safety — does the draft ever become a write without a
 * human, and are the numbers recomputed rather than trusted.
 */

const CONTEXT = {
  customerNames: ['Ramesh Kumar', 'Priya Singh', 'Nargis Bano', 'Amit Shaw'],
  productNames: ['Rice', 'Cooking Oil', 'Detergent', 'Sugar', 'Soap'],
};

describe('local transcript parser', () => {
  it('parses the canonical Hinglish sentence', () => {
    const result = parseTranscriptLocally(
      'Ramesh ko 2 kilo chawal aur ek tel diya. 300 UPI kiya aur 120 baaki hai.',
      CONTEXT,
    );

    expect(result.customer).toBe('Ramesh Kumar');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ name: 'Rice', quantity: 2, unit: 'kg' });
    expect(result.items[1]).toMatchObject({ name: 'Cooking Oil', quantity: 1 });
    expect(result.paidRupees).toBe(300);
    expect(result.outstandingRupees).toBe(120);
    expect(result.paymentMethod).toBe('upi');
  });

  it('does not confuse money still owed with money paid', () => {
    // "baaki" is the single most consequential word in this domain: reading it
    // as "paid" silently erases a debt.
    const result = parseTranscriptLocally('Priya ka 500 baaki hai', CONTEXT);

    expect(result.outstandingRupees).toBe(500);
    expect(result.paidRupees).toBeNull();
  });

  it('understands English phrasing', () => {
    const result = parseTranscriptLocally(
      'Sold 3 kg rice to Priya, paid 200 by cash',
      CONTEXT,
    );

    expect(result.customer).toBe('Priya Singh');
    expect(result.items[0]).toMatchObject({ name: 'Rice', quantity: 3, unit: 'kg' });
    expect(result.paidRupees).toBe(200);
    expect(result.paymentMethod).toBe('cash');
  });

  it('reads Hindi number words', () => {
    const result = parseTranscriptLocally('Ramesh ko do kilo chawal diya', CONTEXT);
    expect(result.items[0]).toMatchObject({ name: 'Rice', quantity: 2 });
  });

  it('applies scale words like sau and hazaar', () => {
    const result = parseTranscriptLocally('Ramesh ka paanch sau baaki hai', CONTEXT);
    expect(result.outstandingRupees).toBe(500);
  });

  it('merges repeated mentions of the same product', () => {
    const result = parseTranscriptLocally('2 kilo chawal aur 3 kilo chawal diya', CONTEXT);
    const rice = result.items.filter((item) => item.name === 'Rice');
    expect(rice).toHaveLength(1);
    expect(rice[0]!.quantity).toBe(5);
  });

  it('never invents a price', () => {
    const result = parseTranscriptLocally('Ramesh ko 2 kilo chawal diya', CONTEXT);
    expect(result.items[0]!.unitPriceRupees).toBeNull();
  });

  it('flags arithmetic that does not add up', () => {
    const result = parseTranscriptLocally(
      'Ramesh ko saman diya. Total 500. 300 diya aur 100 baaki hai.',
      CONTEXT,
    );

    expect(result.ambiguities.some((note) => note.includes('do not add up'))).toBe(true);
    expect(result.confidence).toBeLessThan(0.7);
  });

  it('reports low confidence when nothing is recognisable', () => {
    const result = parseTranscriptLocally('hello there how are you', CONTEXT);
    expect(result.items).toHaveLength(0);
    expect(result.confidence).toBeLessThan(0.5);
  });

  /**
   * Devanagari is what a hi-IN recogniser actually returns — not romanised
   * Hinglish. These are the regression tests for the bug where the tokeniser
   * stripped combining marks (splitting "किलो" into "क" and "ल") and the
   * lexicon held only Latin keys, which together made every Hindi transcript
   * unparseable.
   */
  describe('Devanagari', () => {
    it('parses a Hindi sentence end to end', () => {
      const result = parseTranscriptLocally(
        'रमेश को 2 किलो चावल और एक तेल दिया। 300 यूपीआई किया और 120 बाकी है।',
        CONTEXT,
      );

      expect(result.customer).toBe('Ramesh Kumar');
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({ name: 'Rice', quantity: 2, unit: 'kg' });
      expect(result.items[1]).toMatchObject({ name: 'Cooking Oil', quantity: 1 });
      expect(result.paidRupees).toBe(300);
      expect(result.outstandingRupees).toBe(120);
      expect(result.paymentMethod).toBe('upi');
    });

    it('keeps combining marks, so multi-syllable words survive', () => {
      // "किलो" and "चावल" both depend on matras that a \p{L}-only character
      // class would strip.
      const result = parseTranscriptLocally('50 किलो चावल', CONTEXT);
      expect(result.items[0]).toMatchObject({ name: 'Rice', quantity: 50, unit: 'kg' });
    });

    it('reads Devanagari digits', () => {
      const result = parseTranscriptLocally('रमेश को ५ किलो चावल दिया', CONTEXT);
      expect(result.items[0]).toMatchObject({ name: 'Rice', quantity: 5 });
    });

    it('matches a name written in a different script', () => {
      // Stored as "Nargis Bano", heard as "नरगीस".
      const result = parseTranscriptLocally('नरगीस को 50 किलो चावल चाहिए', CONTEXT);
      expect(result.customer).toBe('Nargis Bano');
    });

    it('matches a short name when grammar corroborates it', () => {
      // "अमित" has only two consonants, which is accepted because it sits
      // immediately before the recipient particle "को".
      const result = parseTranscriptLocally('अमित को तीन किलो चीनी दी, सब नकद', CONTEXT);
      expect(result.customer).toBe('Amit Shaw');
      expect(result.items[0]).toMatchObject({ name: 'Sugar', quantity: 3, unit: 'kg' });
      expect(result.paymentMethod).toBe('cash');
    });

    it('reads Hindi number words', () => {
      const result = parseTranscriptLocally('सुमन को दो साबुन दिए', {
        ...CONTEXT,
        customerNames: [...CONTEXT.customerNames, 'Suman Das'],
      });
      expect(result.items[0]).toMatchObject({ name: 'Soap', quantity: 2 });
    });

    it('does not confuse Hindi "baaki" with money paid', () => {
      const result = parseTranscriptLocally('प्रिया का 500 बाकी है', CONTEXT);
      expect(result.customer).toBe('Priya Singh');
      expect(result.outstandingRupees).toBe(500);
      expect(result.paidRupees).toBeNull();
    });
  });

  describe('name skeletons', () => {
    it('matches the same name across scripts', () => {
      expect(nameSkeleton('नरगीस')).toBe(nameSkeleton('Nargis'));
      expect(nameSkeleton('रमेश')).toBe(nameSkeleton('Ramesh'));
      expect(nameSkeleton('प्रिया')).toBe(nameSkeleton('Priya'));
    });

    it('is tolerant of romanisation variants', () => {
      expect(nameSkeleton('Nargees')).toBe(nameSkeleton('Nargis'));
      expect(nameSkeleton('Kavitha')).toBe(nameSkeleton('Kavita'));
    });

    it('keeps genuinely different names apart', () => {
      expect(nameSkeleton('Ramesh')).not.toBe(nameSkeleton('Suresh'));
      expect(nameSkeleton('Priya')).not.toBe(nameSkeleton('Pooja'));
    });
  });

  it('always produces schema-valid output', () => {
    const transcripts = [
      'Ramesh ko 2 kilo chawal diya',
      '',
      '12345',
      'aur aur aur',
      'Priya ko 1 tel aur 2 sabun diya, 450 cash',
      'नरगीस को 50 किलो चावल चाहिए',
      'और और और',
      '।।।',
      'ஐந்து கிலோ அரிசி',
    ];

    for (const transcript of transcripts) {
      const result = parseTranscriptLocally(transcript, CONTEXT);
      // The gate between extraction and the domain layer must never reject our
      // own parser's output.
      expect(ExtractedTransactionSchema.safeParse(result).success).toBe(true);
    }
  });
});

describe('voice draft', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'voice@test.app', shopName: 'Sharma Stores' });

    await products.put({
      productId: newProductId(),
      vendorId: shop.vendor.vendorId,
      name: 'Cooking Oil',
      sku: 'OIL',
      category: 'staples',
      unit: 'litre',
      costPrice: 12800,
      sellingPrice: 15200,
      stock: 40,
      reorderLevel: 10,
      supplier: '',
    purchaseDate: '',
    salesVelocity: 0,
      aliases: ['tel'],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  });

  it('resolves the customer and prices items from the catalogue', async () => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: {
        transcript: 'Ramesh ko 2 kilo chawal aur ek tel diya. 300 UPI kiya aur 120 baaki hai.',
        language: 'hi',
      },
    });

    expect(response.status).toBe(200);
    const draft = TransactionDraftSchema.parse(response.body.draft);

    expect(draft.customerId).toBe(shop.customer.customerId);
    expect(draft.customerName).toBe('Ramesh Kumar');
    expect(draft.items).toHaveLength(2);
    // Prices came from the catalogue, not from the transcript.
    expect(draft.items[0]!.unitPrice).toBe(6200);
    expect(draft.items[1]!.unitPrice).toBe(15200);
  });

  // A credit sale recorded as settled is the one mistake a shopkeeper cannot
  // spot by eye — the khata simply loses the debt. Each script gets its own
  // case because the word is what triggers the branch.
  it.each([
    ['Hinglish', 'Ramesh ko 2 kilo chawal udhaar'],
    ['English', 'Ramesh ko 2 kilo chawal on credit'],
    ['Devanagari', 'रमेश को दो किलो चावल उधार'],
  ])('records an udhaar sale as outstanding, not paid (%s)', async (_label, transcript) => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript, language: 'hi' },
    });

    expect(response.status).toBe(200);
    const draft = TransactionDraftSchema.parse(response.body.draft);

    expect(draft.paymentMethod).toBe('credit');
    expect(draft.total).toBeGreaterThan(0);
    expect(draft.paid).toBe(0);
    expect(draft.outstanding).toBe(draft.total);
    // The shopkeeper said what they meant, so nothing was assumed on their behalf.
    expect(draft.warnings).not.toContain(
      'No payment was mentioned — we assumed it was paid in full.',
    );
  });

  it('still assumes paid in full when no payment word is spoken', async () => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript: 'Ramesh ko 2 kilo chawal', language: 'hi' },
    });

    const draft = TransactionDraftSchema.parse(response.body.draft);
    expect(draft.paid).toBe(draft.total);
    expect(draft.outstanding).toBe(0);
    expect(draft.warnings).toContain(
      'No payment was mentioned — we assumed it was paid in full.',
    );
  });

  it('lets an explicit paid amount win over the udhaar default', async () => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript: 'Ramesh ko 2 kilo chawal, 50 rupaye diye baaki udhaar', language: 'hi' },
    });

    const draft = TransactionDraftSchema.parse(response.body.draft);
    expect(draft.paid).toBeGreaterThan(0);
    expect(draft.paid + draft.outstanding).toBe(draft.total);
  });

  it('treats the spoken paid and pending amounts as the charged total', async () => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: {
        transcript: 'Ramesh ko 2 kilo chawal aur ek tel diya. 300 UPI kiya aur 120 baaki hai.',
        language: 'hi',
      },
    });

    const draft = TransactionDraftSchema.parse(response.body.draft);

    expect(draft.paid).toBe(30000);
    expect(draft.outstanding).toBe(12000);
    expect(draft.total).toBe(42000);
    // And the disagreement with catalogue prices is surfaced, not hidden.
    expect(draft.warnings.some((note) => note.includes('listed prices'))).toBe(true);
    expect(draft.needsReview).toBe(true);
  });

  it('marks an unknown customer as new rather than guessing', async () => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript: 'Sunil ko 1 kilo chawal diya, 62 cash', language: 'hi' },
    });

    const draft = TransactionDraftSchema.parse(response.body.draft);
    expect(draft.customerId).toBeNull();
    expect(draft.customerIsNew).toBe(true);
    expect(draft.needsReview).toBe(true);
  });

  it('asks which customer when the name is ambiguous', async () => {
    // A second Ramesh is exactly when a confident guess is most expensive.
    await request('POST', '/customers', {
      token: shop.token,
      body: { name: 'Ramesh Gupta', phone: '9812222222' },
    });

    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript: 'Ramesh ko 1 kilo chawal diya', language: 'hi' },
    });

    const draft = TransactionDraftSchema.parse(response.body.draft);
    expect(draft.customerCandidates.length).toBeGreaterThan(1);
    expect(draft.needsReview).toBe(true);
  });

  it('warns when a product is not in the catalogue', async () => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript: 'Ramesh ko 2 packet cornflakes diya', language: 'en' },
    });

    const draft = TransactionDraftSchema.parse(response.body.draft);
    expect(draft.needsReview).toBe(true);
    expect(draft.warnings.length).toBeGreaterThan(0);
  });

  it('writes nothing to the ledger', async () => {
    const before = await request('GET', '/transactions', { token: shop.token });

    await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript: 'Ramesh ko 2 kilo chawal diya, 124 cash', language: 'hi' },
    });

    const after = await request('GET', '/transactions', { token: shop.token });

    // The whole safety model in one assertion: parsing is not saving.
    expect((after.body.transactions as unknown[]).length).toBe(
      (before.body.transactions as unknown[]).length,
    );

    const product = await products.require(shop.vendor.vendorId, shop.product.productId);
    expect(product.stock).toBe(100);
  });

  it('rejects an empty transcript', async () => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript: '', language: 'en' },
    });

    expect(response.status).toBe(422);
  });

  it('reports which engine produced the draft', async () => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript: 'Ramesh ko 1 kilo chawal diya', language: 'hi' },
    });

    const draft = TransactionDraftSchema.parse(response.body.draft);
    // Bedrock is off in tests, and the UI must be told so rather than implying
    // an AI reading.
    expect(draft.engine).toBe('local-parser');
  });
});

/**
 * Multi-item requests.
 *
 * The bug these pin down: the parser walked the whole sentence but only emitted
 * words the shop's catalogue recognised, so "4 litre milk aur 3 bread" reached
 * the draft as milk alone. Nothing announced the loss — the second half of what
 * the customer asked for simply was not there, and the shopkeeper had no way to
 * know the sentence had contained it.
 */
describe('parsing more than one item', () => {
  const SHOP = {
    customerNames: ['Arpita Sen', 'Ramesh Kumar'],
    productNames: ['Milk', 'Tea', 'Rice', 'Sugar', 'Biscuits', 'Cooking Oil', 'Wheat Flour'],
  };

  const names = (transcript: string, context = SHOP) =>
    parseTranscriptLocally(transcript, context).items.map((item) => item.name);

  it('keeps every item in a two-item request', () => {
    const result = parseTranscriptLocally(
      'Arpita ko 4 liter milk aur 3 tea packets chahiye, 200 de chuki hai',
      SHOP,
    );

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ name: 'Milk', quantity: 4, unit: 'litre' });
    expect(result.items[1]).toMatchObject({ name: 'Tea', quantity: 3, unit: 'packet' });
    expect(result.paidRupees).toBe(200);
  });

  it('handles every separator a shopkeeper actually uses', () => {
    expect(names('2 milk aur 3 biscuits')).toEqual(['Milk', 'Biscuits']);
    expect(names('5 kg rice aur 2 litre oil')).toEqual(['Rice', 'Cooking Oil']);
    expect(names('2 packets tea, 3 biscuits aur 1 kg sugar')).toEqual(['Tea', 'Biscuits', 'Sugar']);
    expect(names('4 liter milk and 3 tea packets')).toEqual(['Milk', 'Tea']);
    expect(names('milk 4 litre, tea 3 packet, sugar 2 kg')).toEqual(['Milk', 'Tea', 'Sugar']);
  });

  it('understands Hindi product words', () => {
    const result = parseTranscriptLocally(
      'Ramesh ko 4 doodh aur 2 chai ke packet chahiye',
      SHOP,
    );
    expect(result.items.map((item) => item.name)).toEqual(['Milk', 'Tea']);
    expect(result.items[0]!.quantity).toBe(4);
    expect(result.items[1]!.quantity).toBe(2);
  });

  it('has no ceiling on how many items one sentence can hold', () => {
    const result = parseTranscriptLocally(
      '2 kg rice, 3 milk, 4 tea packets, 2 biscuits aur 1 kg sugar',
      SHOP,
    );
    expect(result.items).toHaveLength(5);
    expect(result.items.map((item) => item.name)).toEqual([
      'Rice',
      'Milk',
      'Tea',
      'Biscuits',
      'Sugar',
    ]);
  });

  it('keeps an item the shop does not stock, rather than dropping it', () => {
    const result = parseTranscriptLocally('4 liter milk aur 3 bread packets', SHOP);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.name).toBe('Milk');
    // Reported as spoken. Whether it can be supplied is decided downstream,
    // against the real inventory — but it must survive to get there.
    expect(result.items[1]).toMatchObject({ name: 'Bread', quantity: 3 });
  });

  it('does not invent products out of the verbs around them', () => {
    // A number *after* a word does not make that word a product.
    expect(names('Sold 3 kg rice to Ramesh')).toEqual(['Rice']);
    expect(names('Ramesh ko 2 kilo rice diya')).toEqual(['Rice']);
    // Nor does the customer's own name, however it is quantified.
    expect(names('Arpita ko 2 milk')).toEqual(['Milk']);
  });

  it('merges a product said twice into one line', () => {
    const result = parseTranscriptLocally('2 kg rice aur 1 kg rice', SHOP);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: 'Rice', quantity: 3, unit: 'kg' });
  });
});

/**
 * Availability on the draft.
 *
 * The draft is where a spoken request meets the shelf. Three outcomes matter,
 * and the difference between the last two is the difference between a sale that
 * can go ahead in part and one that cannot go ahead at all — so both stay
 * visible, with what was asked for recorded next to what can be supplied.
 */
describe('voice draft availability', () => {
  let shop: TestShop;

  const stock = async (name: string, quantity: number, sellingPrice: number, unit: string) => {
    await products.put({
      productId: newProductId(),
      vendorId: shop.vendor.vendorId,
      name,
      sku: name.slice(0, 6).toUpperCase(),
      category: 'staples',
      unit,
      costPrice: Math.round(sellingPrice * 0.8),
      sellingPrice,
      stock: quantity,
      reorderLevel: 2,
      supplier: 'Shree Traders',
      purchaseDate: '2026-09-10',
      salesVelocity: 0,
      aliases: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  };

  const parse = async (transcript: string) => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript },
    });
    expect(response.status).toBe(200);
    return TransactionDraftSchema.parse((response.body as { draft: unknown }).draft);
  };

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'avail@test.app', shopName: 'Sharma Stores' });
    await stock('Milk', 10, 6000, 'litre');
    await stock('Tea', 0, 3000, 'packet');
    await stock('Sugar', 5, 5000, 'kg');
  });

  it('charges only for what it can supply, and keeps the rest on the draft', async () => {
    const draft = await parse('4 litre milk, 3 tea aur 2 kg sugar');

    expect(draft.items).toHaveLength(3);

    const [milk, tea, sugar] = draft.items;

    expect(milk).toMatchObject({
      name: 'Milk',
      availability: 'available',
      requestedQuantity: 4,
      fulfilledQuantity: 4,
      lineTotal: 24_000,
    });

    // Out of stock, still listed, charged nothing.
    expect(tea).toMatchObject({
      name: 'Tea',
      availability: 'unavailable',
      requestedQuantity: 3,
      availableQuantity: 0,
      fulfilledQuantity: 0,
      lineTotal: 0,
    });

    expect(sugar).toMatchObject({
      name: 'Sugar',
      availability: 'available',
      requestedQuantity: 2,
      lineTotal: 10_000,
    });

    // 240 + 0 + 100
    expect(draft.total).toBe(34_000);
    expect(draft.unfulfilledCount).toBe(1);
  });

  it('supplies what it has when the request runs past the shelf', async () => {
    // Asking for exactly what is there is met in full, not "insufficient".
    const draft = await parse('10 litre milk');

    expect(draft.items[0]).toMatchObject({
      availability: 'available',
      requestedQuantity: 10,
      availableQuantity: 10,
      fulfilledQuantity: 10,
    });

    // Now ask for more than there is.
    const beyond = await parse('25 litre milk');
    expect(beyond.items[0]).toMatchObject({
      availability: 'insufficient',
      requestedQuantity: 25,
      availableQuantity: 10,
      fulfilledQuantity: 10,
      lineTotal: 60_000,
    });
    expect(beyond.total).toBe(60_000);
    expect(beyond.unfulfilledCount).toBe(1);
  });

  it('lists a product the shop has never stocked', async () => {
    const draft = await parse('4 litre milk aur 3 bread');

    expect(draft.items).toHaveLength(2);
    expect(draft.items[1]).toMatchObject({
      name: 'Bread',
      availability: 'unavailable',
      inCatalogue: false,
      requestedQuantity: 3,
      fulfilledQuantity: 0,
      lineTotal: 0,
    });
    expect(draft.total).toBe(24_000);
  });

  it('splits an overpayment into change rather than a negative balance', async () => {
    const draft = await parse('4 litre milk, 500 de diye');

    expect(draft.total).toBe(24_000);
    expect(draft.paid).toBe(50_000);
    expect(draft.outstanding).toBe(0);
    expect(draft.change).toBe(26_000);
  });

  it('leaves the balance owing when less was paid than the bill', async () => {
    const draft = await parse('4 litre milk, 100 de diye');

    expect(draft.total).toBe(24_000);
    expect(draft.paid).toBe(10_000);
    expect(draft.outstanding).toBe(14_000);
    expect(draft.change).toBe(0);
  });

  it('does not touch stock — parsing is not selling', async () => {
    await parse('4 litre milk aur 2 kg sugar');

    const catalogue = await products.list(shop.vendor.vendorId);
    expect(catalogue.find((product) => product.name === 'Milk')!.stock).toBe(10);
    expect(catalogue.find((product) => product.name === 'Sugar')!.stock).toBe(5);
  });

  it('deducts only the fulfilled quantity once the sale is confirmed', async () => {
    const draft = await parse('25 litre milk aur 3 tea');

    // The client sends only what can be supplied, which is what the draft says.
    const sellable = draft.items.filter((item) => item.fulfilledQuantity > 0);
    expect(sellable).toHaveLength(1);

    const response = await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: sellable.map((item) => ({
          ...(item.productId ? { productId: item.productId } : {}),
          name: item.name,
          quantity: item.fulfilledQuantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
        })),
        paid: 0,
        paymentMethod: 'credit',
        source: 'voice',
      },
    });
    expect(response.status).toBe(201);

    const catalogue = await products.list(shop.vendor.vendorId);
    // 10 sold out of the 25 asked for.
    expect(catalogue.find((product) => product.name === 'Milk')!.stock).toBe(0);
    // Tea was never sold, so it was never deducted.
    expect(catalogue.find((product) => product.name === 'Tea')!.stock).toBe(0);
  });
});

/**
 * Money that was said to be owed.
 *
 * The failure these pin down turned a credit sale into a settled one. The
 * shopkeeper said, in plain words, that the money was still to come — "poora
 * dena baaki hai paisa" — and the draft came back marked paid in full, warning
 * that no payment had been mentioned. A khata that quietly settles itself is
 * the one error nobody catches by eye, because the screen agrees with the shop
 * about everything except the part that matters.
 */
describe('unpaid without a figure', () => {
  const SHOP = {
    customerNames: ['Arpita Sen'],
    productNames: ['Rice', 'Milk', 'Tea'],
  };

  const money = (transcript: string) => {
    const result = parseTranscriptLocally(transcript, SHOP);
    return {
      paid: result.paidRupees,
      outstanding: result.outstandingRupees,
      method: result.paymentMethod,
    };
  };

  it('reads "baaki hai" with no amount as the whole bill being owed', () => {
    // No figure is spoken because it is obvious to both people: all of it.
    expect(money('arpita ko 2 kg rice baaki hai').method).toBe('credit');
    expect(money('arpita ko 2 kg rice pending hai').method).toBe('credit');
    expect(money('arpita ko 2 kg rice, paisa due hai').method).toBe('credit');
    expect(money('arpita ko 2 kg rice उधार').method).toBe('credit');
    expect(money('arpita ko 2 kg rice बाकी है').method).toBe('credit');
  });

  it('handles the exact sentence that was reported', () => {
    const result = parseTranscriptLocally(
      'arpita ko 2 kg rice 2 litre milk 4 packet tea chahiyeeee poora dena baaki haiii paisa',
      SHOP,
    );

    expect(result.items.map((item) => item.name)).toEqual(['Rice', 'Milk', 'Tea']);
    expect(result.paymentMethod).toBe('credit');
    // Nothing was handed over, so no figure should be invented for either side.
    expect(result.paidRupees).toBeNull();
  });

  it('does not override a split the shopkeeper actually stated', () => {
    expect(money('arpita ko 2 kg rice, 100 diya 50 baaki hai')).toMatchObject({
      paid: 100,
      outstanding: 50,
    });
    expect(money('arpita ko 2 kg rice, 150 cash diya')).toMatchObject({ paid: 150 });
  });

  it('still assumes settled when money is never mentioned at all', () => {
    expect(money('arpita ko 2 kg rice')).toMatchObject({
      paid: null,
      outstanding: null,
      method: null,
    });
  });
});

/**
 * Words held too long.
 *
 * Dictation and typing both carry a stretched vowel straight through, and a
 * stretched word matches nothing in any lexicon. "baaki haiii" stopped meaning
 * "money is owed" purely because of how long the speaker held the vowel.
 */
describe('stretched speech', () => {
  const SHOP = { customerNames: ['Arpita Sen'], productNames: ['Rice', 'Milk', 'Tea'] };

  it('understands a word however long it is held', () => {
    expect(parseTranscriptLocally('arpita ko 2 kg rice baaki haiii', SHOP).paymentMethod).toBe(
      'credit',
    );
    expect(parseTranscriptLocally('arpita ko 2 kg riceeee chahiyeeee', SHOP).items).toHaveLength(1);
    expect(parseTranscriptLocally('arpita ko 2 kg rice udhaaaar', SHOP).paymentMethod).toBe(
      'credit',
    );
  });

  it('leaves doubled letters alone, because Hindi needs them', () => {
    // "baaki", "poora" and "chawal" all depend on a surviving double letter.
    const result = parseTranscriptLocally('ramesh ko 2 kilo chawal, poora baaki hai', {
      customerNames: ['Ramesh Kumar'],
      productNames: ['Rice'],
    });
    expect(result.items[0]!.name).toBe('Rice');
    expect(result.paymentMethod).toBe('credit');
  });
});

/**
 * Finding a spoken name on the books.
 *
 * The cost of the two mistakes here is not symmetric. Creating a second Ramesh
 * splits one person's history across two khatas and neither adds up; picking
 * the wrong Ramesh puts money on a stranger's account. So the matcher reports
 * what it found and refuses to choose — the shopkeeper does that.
 */
describe('matching a customer by name', () => {
  let shop: TestShop;

  const add = async (name: string) => {
    const response = await request('POST', '/customers', {
      token: shop.token,
      body: { name },
    });
    expect(response.status).toBe(201);
    return (response.body.customer as { customerId: string }).customerId;
  };

  const resolve = async (name: string) => {
    const response = await request('POST', '/customers/resolve', {
      token: shop.token,
      body: { name },
    });
    expect(response.status).toBe(200);
    return response.body as unknown as {
      found: boolean;
      customer?: { customerId: string; name: string };
      candidates?: Array<{ name: string }>;
    };
  };

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'match@test.app', shopName: 'Sharma Stores' });
  });

  it('finds somebody already on the books', async () => {
    const id = await add('Nargis Bano');

    const result = await resolve('Nargis Bano');
    expect(result.found).toBe(true);
    expect(result.customer!.customerId).toBe(id);
  });

  it('finds them by their first name alone, as a shopkeeper would say it', async () => {
    const id = await add('Nargis Bano');

    const result = await resolve('Nargis');
    expect(result.found).toBe(true);
    expect(result.customer!.customerId).toBe(id);
  });

  it('is not thrown by spacing or case', async () => {
    const id = await add('Nargis Bano');

    for (const spoken of ['  nargis bano ', 'NARGIS BANO', 'Nargis   Bano']) {
      const result = await resolve(spoken);
      expect(`${spoken}: ${result.customer?.customerId}`).toBe(`${spoken}: ${id}`);
    }
  });

  it('matches a Devanagari name', async () => {
    const id = await add('ईशा');

    const result = await resolve('ईशा');
    expect(result.found).toBe(true);
    expect(result.customer!.customerId).toBe(id);
  });

  it('refuses to choose between two people of the same name', async () => {
    await add('Suresh Kumar');
    await add('Suresh Yadav');

    const result = await resolve('Suresh');
    // Not found, but not new either: the shopkeeper decides which Suresh.
    expect(result.found).toBe(false);
    expect(result.candidates?.map((entry) => entry.name).sort()).toEqual([
      'Suresh Kumar',
      'Suresh Yadav',
    ]);
  });

  it('prefers an exact name over one that merely starts with it', async () => {
    const exact = await add('Suresh');
    await add('Suresh Kumar');

    // "Suresh" is ambiguous as a prefix but unambiguous as a whole name, so the
    // question was never really ambiguous.
    const result = await resolve('Suresh');
    expect(result.found).toBe(true);
    expect(result.customer!.customerId).toBe(exact);
  });

  it('says nobody when nobody answers to the name', async () => {
    await add('Nargis Bano');

    const result = await resolve('Arpita');
    expect(result.found).toBe(false);
    expect(result.candidates ?? []).toHaveLength(0);
  });

  it('sees past the first page of a long customer list', async () => {
    // The list was previously read with a limit of 200, so a shop's 201st
    // customer was invisible to the voice flow and would have been created
    // again on every sale.
    const { customers } = await import('../src/services/repository');
    const { newCustomerId, newQrId } = await import('../src/utils/ids');

    for (let index = 0; index < 205; index += 1) {
      await customers.put({
        customerId: newCustomerId(),
        vendorId: shop.vendor.vendorId,
        name: `Customer Number ${String(index).padStart(3, '0')}`,
        phone: '',
        whatsappPhone: '',
        whatsappOptIn: false,
        email: '',
        qrId: newQrId(),
        outstanding: 0,
        totalSpent: 0,
        transactionCount: 0,
        notes: '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }

    /**
     * Every one of them has to be findable, not just a sample.
     *
     * Which rows a capped query returns depends on the customer-id ordering,
     * which is random — so checking one name proves nothing. Checking all of
     * them means a cap of 200 must leave at least five unfound.
     */
    const { findCustomerByName } = await import('../src/services/customerMatch');

    let found = 0;
    for (let index = 0; index < 205; index += 1) {
      const match = await findCustomerByName(
        shop.vendor.vendorId,
        `Customer Number ${String(index).padStart(3, '0')}`,
      );
      if (match.kind === 'one') found += 1;
    }

    expect(found).toBe(205);
  });
});

/**
 * The preview and the save must agree.
 *
 * Two implementations of "is this Ramesh?" that disagree is worse than either
 * alone: the draft would say a name is new, the confirm would find it, and the
 * shopkeeper would be told two different things about the same person.
 */
describe('the draft and the lookup agree', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'agree@test.app', shopName: 'Sharma Stores' });
    await products.put({
      productId: newProductId(),
      vendorId: shop.vendor.vendorId,
      name: 'Milk',
      sku: 'MILK',
      category: 'dairy',
      unit: 'litre',
      costPrice: 6000,
      sellingPrice: 7200,
      stock: 30,
      reorderLevel: 8,
      supplier: 'Daily Dairy Co.',
      purchaseDate: '2026-09-18',
      salesVelocity: 0,
      aliases: ['doodh'],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  });

  const draftFor = async (transcript: string) => {
    const response = await request('POST', '/voice/parse', {
      token: shop.token,
      body: { transcript },
    });
    return response.body.draft as {
      customerId: string | null;
      customerName: string;
      customerIsNew: boolean;
    };
  };

  it('does not call an existing customer new', async () => {
    const created = await request('POST', '/customers', {
      token: shop.token,
      body: { name: 'ईशा' },
    });
    const id = (created.body.customer as { customerId: string }).customerId;

    const draft = await draftFor('ईशा को 2 लीटर दूध चाहिए');
    expect(draft.customerIsNew).toBe(false);
    expect(draft.customerId).toBe(id);
  });

  it('marks a genuinely unknown name as new, and the lookup says the same', async () => {
    const draft = await draftFor('Arpita ko 2 litre milk chahiye');
    expect(draft.customerIsNew).toBe(true);
    expect(draft.customerId).toBeNull();

    const lookup = await request('POST', '/customers/resolve', {
      token: shop.token,
      body: { name: draft.customerName },
    });
    expect((lookup.body as { found: boolean }).found).toBe(false);
  });

  it('stops calling the name new once that customer exists', async () => {
    expect((await draftFor('Arpita ko 2 litre milk chahiye')).customerIsNew).toBe(true);

    await request('POST', '/customers', { token: shop.token, body: { name: 'Arpita' } });

    const again = await draftFor('Arpita ko 2 litre milk chahiye');
    expect(again.customerIsNew).toBe(false);
    expect(again.customerId).not.toBeNull();
  });
});

/**
 * English product names spoken into a Hindi recogniser.
 *
 * "35 पैकेट साल्ट चाहिए" reported salt as not stocked while forty kilos of it
 * sat on the shelf. The parser strips everything outside `[a-z0-9]` before
 * matching, so a name written in Devanagari became an empty string and matched
 * nothing — and an unrecognised word is not treated as a product at all.
 *
 * Enumerating the spellings would not have fixed it: there is no end to the
 * English nouns a shopkeeper might say in a Hindi sentence.
 */
describe('a product named in the wrong script', () => {
  const SHELF = {
    customerNames: ['Arpita Das'],
    productNames: ['Salt', 'Milk', 'Rice', 'Sugar', 'Biscuits', 'Tea'],
  };

  it('finds the salt that was sitting in stock all along', () => {
    const result = parseTranscriptLocally('अर्पिता को 35 पैकेट साल्ट चाहिए', SHELF);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: 'Salt', quantity: 35, unit: 'packet' });
  });

  it('reads the other English names dictation writes in Devanagari', () => {
    for (const [spoken, expected] of [
      ['अर्पिता को 2 लीटर मिल्क चाहिए', 'Milk'],
      ['अर्पिता को 3 किलो राइस चाहिए', 'Rice'],
      ['अर्पिता को 1 किलो शुगर चाहिए', 'Sugar'],
      ['अर्पिता को 2 पैकेट बिस्किट चाहिए', 'Biscuits'],
    ] as const) {
      const result = parseTranscriptLocally(spoken, SHELF);
      expect(result.items.map((item) => item.name), spoken).toEqual([expected]);
    }
  });

  it('still reads the Hindi name for the same thing', () => {
    // The point is to add a spelling, not to trade one for another.
    const result = parseTranscriptLocally('अर्पिता को 2 किलो नमक चाहिए', SHELF);
    expect(result.items.map((item) => item.name)).toEqual(['Salt']);
  });

  it('does not hear tea in the word that ends every order', () => {
    /**
     * "चाहिए" — "is needed" — reduces to the same sound as "chai". Sound
     * matching is coarse by design, so words the parser already reads as
     * grammar are refused outright rather than looked up: otherwise every
     * spoken sale grew a packet of tea that nobody asked for, and the
     * shopkeeper would be billing a customer for it.
     */
    const result = parseTranscriptLocally('अर्पिता को 2 किलो नमक चाहिए', SHELF);
    expect(result.items.map((item) => item.name)).toEqual(['Salt']);
  });

  it('does not hear dal in an ordinary English word', () => {
    // "there" reduces to the same skeleton as "toor", a variety of dal. Sound
    // matching is for words a Hindi recogniser wrote in Devanagari; the English
    // words that are not products far outnumber the ones that are.
    const result = parseTranscriptLocally('hello there how are you', SHELF);
    expect(result.items).toEqual([]);
  });

  it('mixes scripts in one sentence without losing the product', () => {
    const result = parseTranscriptLocally('Arpita ko 2 किलो साल्ट चाहिए', SHELF);
    expect(result.items.map((item) => item.name)).toEqual(['Salt']);
  });

  it('adds no items to a transcript that is only about money', () => {
    const result = parseTranscriptLocally('अर्पिता को 500 रुपये दिया', SHELF);
    expect(result.items).toEqual([]);
  });

  it('leaves a word alone when the shop stocks nothing like it', () => {
    // Not stocked is a real answer. Reaching for the nearest-sounding product
    // would put something else in the basket.
    const result = parseTranscriptLocally('अर्पिता को 2 किलो शैम्पू चाहिए', SHELF);
    expect(result.items.every((item) => item.name !== 'Salt')).toBe(true);
    expect(result.items.map((item) => item.name)).not.toContain('Sugar');
  });
});
