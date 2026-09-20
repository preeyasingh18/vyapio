import type { ExtractedItem, ExtractedTransaction } from '../schemas/ai';
import { hasDevanagari, phoneticKey } from '../utils/transliterate';
import type { PaymentMethod } from '../schemas/common';

/**
 * Deterministic transcript parser.
 *
 * Two jobs. It is the parser when Bedrock is not configured, so voice capture
 * works end to end on a laptop with no AWS account. And it is the sanity check
 * when Bedrock *is* configured: services/bedrock.ts runs both and flags any
 * disagreement on money as an ambiguity, because a model that quietly hears
 * ₹480 as ₹580 is the single most expensive failure this product can have.
 *
 * ── Scripts ─────────────────────────────────────────────────────────────────
 *
 * A speech recogniser set to hi-IN returns **Devanagari**, not romanised
 * Hinglish:
 *
 *   "नरगीस को 50 किलो चावल चाहिए"   not   "Nargis ko 50 kilo chawal chahiye"
 *
 * So every lexicon below carries both, and the same for Bengali, Tamil, Telugu
 * and Kannada. Customer names are matched on a consonant skeleton, which
 * survives the gap between a name typed as "Nargis" and the same name heard as
 * "नरगीस".
 *
 * It is a rule engine, not a language model. It reports low confidence when it
 * is guessing, and the preview screen never presents its output as settled.
 */

/* ----------------------------------------------------------------- Lexicon */

/**
 * Spoken product word → catalogue name.
 *
 * Latin keys cover romanised Hinglish and English; the Indic keys cover what a
 * recogniser actually returns when the language is set to that script.
 */
const PRODUCT_LEXICON: Record<string, string> = {
  // ── Rice ────────────────────────────────────────────────────────────────
  chawal: 'Rice', chaval: 'Rice', rice: 'Rice', basmati: 'Rice',
  चावल: 'Rice', चांवल: 'Rice', राइस: 'Rice', बासमती: 'Rice',
  তণ্ডুল: 'Rice', চাল: 'Rice', চাউল: 'Rice',
  அரிசி: 'Rice',
  బియ్యం: 'Rice', బియ్యము: 'Rice',
  ಅಕ್ಕಿ: 'Rice',
  तांदूळ: 'Rice',

  // ── Atta / flour ────────────────────────────────────────────────────────
  atta: 'Atta', aata: 'Atta', flour: 'Atta', gehu: 'Atta', gehun: 'Atta',
  आटा: 'Atta', गेहूं: 'Atta', गेहूँ: 'Atta',
  আটা: 'Atta', ময়দা: 'Atta',
  மாவு: 'Atta', கோதுமை: 'Atta',
  పిండి: 'Atta', గోధుమ: 'Atta',
  ಹಿಟ್ಟು: 'Atta', ಗೋಧಿ: 'Atta',

  // ── Dal ─────────────────────────────────────────────────────────────────
  dal: 'Dal', daal: 'Dal', lentils: 'Dal', toor: 'Dal', arhar: 'Dal',
  दाल: 'Dal', दाळ: 'Dal', तूर: 'Dal', अरहर: 'Dal',
  ডাল: 'Dal', ডালি: 'Dal',
  பருப்பு: 'Dal',
  పప్పు: 'Dal',
  ಬೇಳೆ: 'Dal',

  // ── Cooking oil ─────────────────────────────────────────────────────────
  tel: 'Cooking Oil', oil: 'Cooking Oil', refined: 'Cooking Oil',
  'cooking oil': 'Cooking Oil',
  तेल: 'Cooking Oil', तेलं: 'Cooking Oil', ऑयल: 'Cooking Oil',
  তেল: 'Cooking Oil',
  எண்ணெய்: 'Cooking Oil',
  నూనె: 'Cooking Oil',
  ಎಣ್ಣೆ: 'Cooking Oil',

  // ── Sugar ───────────────────────────────────────────────────────────────
  cheeni: 'Sugar', chini: 'Sugar', shakkar: 'Sugar', sugar: 'Sugar',
  चीनी: 'Sugar', शक्कर: 'Sugar', शकर: 'Sugar', साखर: 'Sugar',
  চিনি: 'Sugar',
  சர்க்கரை: 'Sugar',
  పంచదార: 'Sugar', చక్కెర: 'Sugar',
  ಸಕ್ಕರೆ: 'Sugar',

  // ── Detergent ───────────────────────────────────────────────────────────
  detergent: 'Detergent', surf: 'Detergent', powder: 'Detergent',
  डिटर्जेंट: 'Detergent', सर्फ: 'Detergent', 'वाशिंग': 'Detergent',
  ডিটারজেন্ট: 'Detergent',
  சோப்புத்தூள்: 'Detergent',
  డిటర్జెంట్: 'Detergent',
  ಡಿಟರ್ಜೆಂಟ್: 'Detergent',

  // ── Soap ────────────────────────────────────────────────────────────────
  sabun: 'Soap', saabun: 'Soap', soap: 'Soap',
  साबुन: 'Soap', साबण: 'Soap',
  সাবান: 'Soap',
  சோப்பு: 'Soap',
  సబ్బు: 'Soap',
  ಸಾಬೂನು: 'Soap',

  // ── Tea ─────────────────────────────────────────────────────────────────
  chai: 'Tea', chaipatti: 'Tea', tea: 'Tea', patti: 'Tea',
  चाय: 'Tea', चायपत्ती: 'Tea',
  চা: 'Tea',
  தேயிலை: 'Tea', டீ: 'Tea',
  టీ: 'Tea', తేయాకు: 'Tea',
  ಚಹಾ: 'Tea', ಟೀ: 'Tea',

  // ── Biscuits ────────────────────────────────────────────────────────────
  biscuit: 'Biscuits', biscuits: 'Biscuits', parle: 'Biscuits',
  बिस्कुट: 'Biscuits', बिस्किट: 'Biscuits',
  বিস্কুট: 'Biscuits',
  பிஸ்கட்: 'Biscuits',
  బిస్కెట్: 'Biscuits',
  ಬಿಸ್ಕತ್ತು: 'Biscuits',

  // ── Salt ────────────────────────────────────────────────────────────────
  namak: 'Salt', salt: 'Salt',
  नमक: 'Salt', मीठ: 'Salt',
  নুন: 'Salt', লবণ: 'Salt',
  உப்பு: 'Salt',
  ఉప్పు: 'Salt',
  ಉಪ್ಪು: 'Salt',

  // ── Milk / eggs ─────────────────────────────────────────────────────────
  doodh: 'Milk', milk: 'Milk',
  दूध: 'Milk',
  দুধ: 'Milk',
  பால்: 'Milk',
  పాలు: 'Milk',
  ಹಾಲು: 'Milk',

  anda: 'Eggs', ande: 'Eggs', eggs: 'Eggs',
  अंडा: 'Eggs', अंडे: 'Eggs',
  ডিম: 'Eggs',
  முட்டை: 'Eggs',
  గుడ్డు: 'Eggs',
  ಮೊಟ್ಟೆ: 'Eggs',
};

/** Spoken unit → canonical unit. */
const UNIT_LEXICON: Record<string, string> = {
  kilo: 'kg', kilos: 'kg', kg: 'kg', kgs: 'kg', kilogram: 'kg',
  किलो: 'kg', किग्रा: 'kg', किलोग्राम: 'kg',
  কিলো: 'kg', কেজি: 'kg',
  கிலோ: 'kg',
  కిలో: 'kg',
  ಕಿಲೋ: 'kg',

  gram: 'g', grams: 'g', gm: 'g', g: 'g',
  ग्राम: 'g', গ্রাম: 'g', கிராம்: 'g', గ్రాము: 'g', ಗ್ರಾಂ: 'g',

  litre: 'litre', litres: 'litre', liter: 'litre', liters: 'litre',
  lt: 'litre', ltr: 'litre', l: 'litre',
  लीटर: 'litre', लिटर: 'litre',
  লিটার: 'litre', லிட்டர்: 'litre', లీటరు: 'litre', ಲೀಟರ್: 'litre',

  ml: 'ml', एमएल: 'ml',

  packet: 'packet', packets: 'packet', pack: 'packet', packs: 'packet',
  पैकेट: 'packet', पैकिट: 'packet',
  প্যাকেট: 'packet', பாக்கெட்: 'packet', ప్యాకెట్: 'packet', ಪ್ಯಾಕೆಟ್: 'packet',

  dozen: 'dozen', दर्जन: 'dozen', ডজন: 'dozen',

  piece: 'piece', pieces: 'piece', pcs: 'piece',
  पीस: 'piece', नग: 'piece',
  পিস: 'piece', துண்டு: 'piece', ముక్క: 'piece', ತುಂಡು: 'piece',

  bottle: 'bottle', bottles: 'bottle',
  बोतल: 'bottle', বোতল: 'bottle',

  box: 'box', boxes: 'box', डिब्बा: 'box', बॉक्स: 'box',
};

/** Spoken number words, across scripts. */
const NUMBER_WORDS: Record<string, number> = {
  ek: 1, one: 1, एक: 1, এক: 1, ஒன்று: 1, ఒకటి: 1, ಒಂದು: 1,
  do: 2, two: 2, दो: 2, दोन: 2, দুই: 2, இரண்டு: 2, రెండు: 2, ಎರಡು: 2,
  teen: 3, three: 3, तीन: 3, তিন: 3, மூன்று: 3, మూడు: 3, ಮೂರು: 3,
  char: 4, chaar: 4, four: 4, चार: 4, চার: 4, நான்கு: 4, నాలుగు: 4, ನಾಲ್ಕು: 4,
  panch: 5, paanch: 5, five: 5, पांच: 5, पाँच: 5, পাঁচ: 5, ஐந்து: 5, ఐదు: 5, ಐದು: 5,
  chah: 6, chhe: 6, six: 6, छह: 6, छे: 6, ছয়: 6, ஆறு: 6, ఆరు: 6, ಆರು: 6,
  saat: 7, seven: 7, सात: 7, সাত: 7, ஏழு: 7, ఏడు: 7, ಏಳು: 7,
  aath: 8, eight: 8, आठ: 8, আট: 8, எட்டு: 8, ఎనిమిది: 8, ಎಂಟು: 8,
  nau: 9, nine: 9, नौ: 9, নয়: 9, ஒன்பது: 9, తొమ్మిది: 9, ಒಂಬತ್ತು: 9,
  das: 10, ten: 10, दस: 10, দশ: 10, பத்து: 10, పది: 10, ಹತ್ತು: 10,

  aadha: 0.5, adha: 0.5, half: 0.5, आधा: 0.5, আধা: 0.5,
  dedh: 1.5, डेढ़: 1.5,
  paav: 0.25, pav: 0.25, पाव: 0.25,
};

/** Multipliers that follow a number: "2 hazaar" → 2000. */
const SCALE_WORDS: Record<string, number> = {
  sau: 100, hundred: 100, सौ: 100, শত: 100, நூறு: 100, వంద: 100, ನೂರು: 100,
  hazaar: 1000, hazar: 1000, hajar: 1000, thousand: 1000,
  हज़ार: 1000, हजार: 1000, হাজার: 1000, ஆயிரம்: 1000, వెయ్యి: 1000, ಸಾವಿರ: 1000,
};

const PAYMENT_KEYWORDS: Array<{ words: string[]; method: PaymentMethod }> = [
  {
    words: [
      'upi', 'gpay', 'googlepay', 'phonepe', 'paytm', 'online', 'scan',
      'यूपीआई', 'ऑनलाइन', 'फोनपे', 'पेटीएम', 'गूगलपे',
      'ইউপিআই', 'ஆன்லைன்', 'ఆన్‌లైన్', 'ಆನ್‌ಲೈನ್',
    ],
    method: 'upi',
  },
  {
    words: [
      'cash', 'nakad', 'nagad', 'nakd', 'rokad',
      'नकद', 'कैश', 'रोकड', 'रोख',
      'নগদ', 'ক্যাশ', 'பணம்', 'ரொக்கம்', 'నగదు', 'ನಗದು',
    ],
    method: 'cash',
  },
  {
    words: ['card', 'debit', 'swipe', 'कार्ड', 'কার্ড', 'கார்டு', 'కార్డు', 'ಕಾರ್ಡ್'],
    method: 'card',
  },
  {
    words: [
      'udhaar', 'udhar', 'uddhar', 'credit', 'khata',
      'उधार', 'उधारी', 'खाता', 'खाते',
      'ধার', 'বাকি', 'கடன்', 'అప్పు', 'ಸಾಲ',
    ],
    method: 'credit',
  },
];

/** Words that mean "still owed". */
const OUTSTANDING_WORDS = [
  'baaki', 'baki', 'bakhi', 'pending', 'udhaar', 'udhar', 'remaining', 'due',
  'balance', 'owes', 'owe', 'reh', 'rahe',
  'बाकी', 'बाक़ी', 'बकाया', 'उधार', 'उधारी', 'पेंडिंग', 'शेष', 'राहिले',
  'বাকি', 'বকেয়া', 'ধার',
  'மீதி', 'பாக்கி', 'கடன்',
  'బాకీ', 'మిగిలిన', 'అప్పు',
  'ಬಾಕಿ', 'ಉಳಿದ', 'ಸಾಲ',
];

/** Words that mean "handed over". */
const PAID_WORDS = [
  'diya', 'diye', 'kiya', 'kiye', 'paid', 'pay', 'de', 'dia', 'bhej',
  'transfer', 'received', 'liya', 'chahiye', 'chaahiye',
  'दिया', 'दिये', 'दिए', 'किया', 'किये', 'दे', 'भेजा', 'लिया', 'चाहिए', 'दिला',
  'দিয়েছি', 'দিলাম', 'নিলেন',
  'கொடுத்தேன்', 'வேண்டும்',
  'ఇచ్చాను', 'కావాలి',
  'ಕೊಟ್ಟೆ', 'ಬೇಕು',
];

const TOTAL_WORDS = [
  'total', 'kul', 'sab', 'altogether', 'bill', 'amount',
  'कुल', 'टोटल', 'सब', 'बिल',
  'মোট', 'মোটে', 'மொத்தம்', 'మొత్తం', 'ಒಟ್ಟು',
];

/** Particles that mark the preceding word as the recipient: "Ramesh ko …". */
const RECIPIENT_PARTICLES = [
  'ko', 'ka', 'ke', 'ki', 'ne',
  'को', 'का', 'के', 'की', 'ने', 'ला', 'नी',
  'কে', 'র', 'কু', 'க்கு', 'கு', 'కు', 'గారికి', 'ಗೆ', 'ಗೆಗೆ',
];

/** Filler words that are never a customer name. */
const FILLER_WORDS = [
  'aur', 'and', 'hai', 'he', 'tha', 'rupaye', 'rupees', 'rs', 'rupee',
  'और', 'है', 'हैं', 'था', 'थे', 'रुपये', 'रुपए', 'रूपये',
  'এবং', 'আছে', 'টাকা',
  'மற்றும்', 'ரூபாய்',
  'మరియు', 'రూపాయలు',
  'ಮತ್ತು', 'ರೂಪಾಯಿ',
];

/* ------------------------------------------------- Script and transliteration */

/**
 * Indic digits → ASCII.
 *
 * A recogniser may return either "50" or "५०" depending on the locale, and
 * `Number('५०')` is NaN.
 */
const DIGIT_RANGES: Array<[number, string]> = [
  [0x0966, 'devanagari'],
  [0x09e6, 'bengali'],
  [0x0be6, 'tamil'],
  [0x0c66, 'telugu'],
  [0x0ce6, 'kannada'],
];

function normaliseDigits(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    let replaced = false;
    for (const [base] of DIGIT_RANGES) {
      if (code >= base && code <= base + 9) {
        out += String(code - base);
        replaced = true;
        break;
      }
    }
    if (!replaced) out += char;
  }
  return out;
}

/**
 * Devanagari consonants, for the name skeleton below. Vowels and matras are
 * deliberately absent — they are what the skeleton throws away.
 */
const DEVANAGARI_CONSONANTS: Record<string, string> = {
  क: 'k', ख: 'k', ग: 'g', घ: 'g', ङ: 'n',
  च: 'ch', छ: 'ch', ज: 'j', झ: 'j', ञ: 'n',
  ट: 't', ठ: 't', ड: 'd', ढ: 'd', ण: 'n',
  त: 't', थ: 't', द: 'd', ध: 'd', न: 'n',
  प: 'p', फ: 'f', ब: 'b', भ: 'b', म: 'm',
  य: 'y', र: 'r', ल: 'l', व: 'v', ळ: 'l',
  श: 'sh', ष: 'sh', स: 's', ह: 'h',
  क़: 'k', ख़: 'k', ग़: 'g', ज़: 'j', ड़: 'r', ढ़: 'r', फ़: 'f',
};

/**
 * A consonant skeleton, comparable across scripts.
 *
 *   "नरगीस"  → n r g s
 *   "Nargis" → n r g s
 *
 * Vowels carry almost no signal across a transliteration boundary — the same
 * name is written Nargis, Nargees, Nargis — while the consonant run is stable.
 * Aspirates collapse (kh → k) because romanisation is inconsistent about them,
 * and v/w and j/z are folded for the same reason.
 */
export function nameSkeleton(text: string): string {
  const source = text.trim().toLowerCase();
  let out = '';

  for (const char of source) {
    const devanagari = DEVANAGARI_CONSONANTS[char];
    if (devanagari) {
      out += devanagari;
      continue;
    }
    // Latin consonants only; everything else (vowels, matras, marks,
    // punctuation, other scripts) is dropped.
    if (/[a-z]/.test(char) && !'aeiou'.includes(char)) out += char;
  }

  return out
    .replace(/h/g, '')      // aspiration is not reliably transliterated
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/(.)\1+/g, '$1'); // collapse doubled consonants
}

/* -------------------------------------------------------------- Tokenising */

type Token = {
  raw: string;
  /** Numeric value when the token is a number or number word. */
  value: number | null;
  index: number;
};

/**
 * Splits a transcript into tokens.
 *
 * `\p{M}` matters enormously: Devanagari matras (ि ी ो ा) are combining
 * *marks*, not letters, so a class of `\p{L}\p{N}` alone strips them and
 * shatters "किलो" into "क" and "ल". That single omission is enough to make
 * every Hindi transcript unparseable.
 */
function tokenise(input: string): Token[] {
  const cleaned = normaliseDigits(input)
    .toLowerCase()
    .replace(/[₹,]/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}.\s]/gu, ' ')
    /**
     * Collapse a drawn-out vowel: "haiii" -> "hai", "chahiyeeee" -> "chahiye".
     *
     * People stretch words when they speak, and both dictation and typing carry
     * that straight through. A stretched word matches nothing in any lexicon, so
     * "baaki haiii" stopped meaning "money is owed" purely because of how long
     * the speaker held the vowel.
     *
     * Only runs of three or more collapse, and they collapse to one. Two is
     * meaningful in transliterated Hindi and must survive untouched — "baaki",
     * "poora" and "chawal" all depend on it.
     */
    .replace(/(.)\1{2,}/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((raw, index) => {
      const numeric = Number(raw);
      const value = Number.isFinite(numeric) && raw !== '' ? numeric : (NUMBER_WORDS[raw] ?? null);
      return { raw, value, index };
    });
}

/** Applies "sau"/"hazaar" to the preceding number: "do sau" → 200. */
function applyScales(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    if (token.value !== null && next && SCALE_WORDS[next.raw] !== undefined) {
      out.push({ ...token, value: token.value * SCALE_WORDS[next.raw]! });
      i += 1;
      continue;
    }
    if (SCALE_WORDS[token.raw] !== undefined && (out.length === 0 || out.at(-1)!.value === null)) {
      // Bare "sau" with no leading number means 100.
      out.push({ ...token, value: SCALE_WORDS[token.raw]! });
      continue;
    }
    out.push(token);
  }
  return out;
}

/* ------------------------------------------------------------------ Parser */

export type LocalParseContext = {
  /** Known customer names, which sharpens recipient detection considerably. */
  customerNames?: string[];
  /** Catalogue names and aliases, so shop-specific products are recognised. */
  productNames?: string[];
};

export function parseTranscriptLocally(
  transcript: string,
  context: LocalParseContext = {},
): ExtractedTransaction {
  const tokens = applyScales(tokenise(transcript));
  const ambiguities: string[] = [];

  const customer = extractCustomer(tokens, transcript, context, ambiguities);
  const amounts = extractAmounts(tokens, ambiguities);

  // An unpriced "baaki hai" is a credit sale: the whole bill is owed. Checked
  // only once no amount has been found, so a spoken split still wins.
  const noAmountSpoken = amounts.paid === null && amounts.outstanding === null;
  const paymentMethod =
    extractPaymentMethod(tokens) ?? (noAmountSpoken && saysNothingWasPaid(tokens) ? 'credit' : null);
  const items = extractItems(tokens, context, amounts.consumedIndexes, customer);

  // Confidence is assembled from what was actually found, not asserted.
  let confidence = 0.35;
  if (customer) confidence += 0.15;
  if (items.length > 0) confidence += 0.2;
  if (amounts.paid !== null || amounts.outstanding !== null) confidence += 0.15;
  if (paymentMethod) confidence += 0.1;
  if (ambiguities.length > 0) confidence -= 0.15 * ambiguities.length;

  if (items.length === 0) {
    ambiguities.push('No products were recognised in what was said.');
  }

  // Cross-check the arithmetic the shopkeeper spoke aloud.
  const { total, paid, outstanding } = amounts;
  if (total !== null && paid !== null && outstanding !== null) {
    if (Math.abs(total - (paid + outstanding)) > 0.5) {
      ambiguities.push(
        `The amounts do not add up: ₹${paid} paid plus ₹${outstanding} pending is not ₹${total}.`,
      );
      confidence -= 0.2;
    }
  }

  return {
    customer,
    items,
    totalRupees: total,
    paidRupees: paid,
    outstandingRupees: outstanding,
    paymentMethod,
    confidence: Math.max(0.05, Math.min(0.95, Number(confidence.toFixed(2)))),
    ambiguities,
  };
}

/* ---------------------------------------------------------------- Customer */

function extractCustomer(
  tokens: Token[],
  original: string,
  context: LocalParseContext,
  ambiguities: string[],
): string | null {
  const known = (context.customerNames ?? []).map((name) => {
    const first = name.toLowerCase().split(/\s+/)[0] ?? '';
    return { name, first, skeleton: nameSkeleton(first), fullSkeleton: nameSkeleton(name) };
  });

  const lower = normaliseDigits(original).toLowerCase();

  // A known customer's name appearing verbatim is the strongest signal.
  const directMatch = known.find(
    (entry) => entry.name.length > 2 && lower.includes(entry.name.toLowerCase()),
  );
  if (directMatch) return directMatch.name;

  const firstNameMatches = known.filter(
    (entry) => entry.first.length > 2 && new RegExp(`\\b${escapeRegex(entry.first)}\\b`).test(lower),
  );
  if (firstNameMatches.length === 1) return firstNameMatches[0]!.name;
  if (firstNameMatches.length > 1) {
    const shared = capitalise(firstNameMatches[0]!.first);
    ambiguities.push(`More than one customer is called ${shared} — please pick the right one.`);
    // The *first name alone*, deliberately. Returning a full name here would
    // resolve to exactly one customer downstream and silently pick for the
    // shopkeeper; the route needs the ambiguity in order to show a picker.
    return shared;
  }

  /**
   * Cross-script match.
   *
   * The recogniser returns "नरगीस" while the customer is stored as "Nargis",
   * so neither of the checks above can fire. Comparing consonant skeletons
   * bridges that, and is the difference between Hindi voice working and not.
   */
  const candidates = tokens.filter(
    (token) => token.value === null && !isKnownWord(token.raw) && token.raw.length > 1,
  );

  /**
   * A word sitting immediately before "को"/"ko"/"ने" is grammatically the
   * recipient, which is strong enough corroboration to accept a short
   * skeleton. Two consonants alone ("अमित" → mt) would be too weak otherwise.
   */
  const isRecipientPosition = (token: Token) => {
    const next = tokens[token.index + 1];
    return next !== undefined && RECIPIENT_PARTICLES.includes(next.raw);
  };

  const skeletonMatches = new Set<string>();
  for (const token of candidates) {
    const skeleton = nameSkeleton(token.raw);
    const minimum = isRecipientPosition(token) ? 2 : 3;
    if (skeleton.length < minimum) continue;

    for (const entry of known) {
      if (entry.skeleton === skeleton || entry.fullSkeleton === skeleton) {
        skeletonMatches.add(entry.name);
      }
    }
  }

  if (skeletonMatches.size === 1) return [...skeletonMatches][0]!;
  if (skeletonMatches.size > 1) {
    const names = [...skeletonMatches];
    ambiguities.push(`That name matches ${names.join(' and ')} — please pick the right one.`);
    return names[0]!;
  }

  // Otherwise fall back to the grammar: the word before "ko"/"ka"/"ne".
  for (let i = 1; i < tokens.length; i += 1) {
    if (!RECIPIENT_PARTICLES.includes(tokens[i]!.raw)) continue;
    const candidate = tokens[i - 1]!;
    if (candidate.value !== null) continue;
    if (isKnownWord(candidate.raw)) continue;
    return capitalise(candidate.raw);
  }

  // English phrasing: "sold to Ramesh", "for Priya".
  const englishMatch = /\b(?:to|for)\s+([a-z]{3,})\b/i.exec(original);
  if (englishMatch?.[1] && !isKnownWord(englishMatch[1].toLowerCase())) {
    return capitalise(englishMatch[1]);
  }

  return null;
}

/** True for vocabulary words, which are never customer names. */
function isKnownWord(word: string): boolean {
  return (
    PRODUCT_LEXICON[word] !== undefined ||
    UNIT_LEXICON[word] !== undefined ||
    NUMBER_WORDS[word] !== undefined ||
    SCALE_WORDS[word] !== undefined ||
    OUTSTANDING_WORDS.includes(word) ||
    PAID_WORDS.includes(word) ||
    TOTAL_WORDS.includes(word) ||
    RECIPIENT_PARTICLES.includes(word) ||
    FILLER_WORDS.includes(word) ||
    PAYMENT_KEYWORDS.some((entry) => entry.words.includes(word))
  );
}

/* ----------------------------------------------------------------- Payment */

function extractPaymentMethod(tokens: Token[]): PaymentMethod | null {
  for (const token of tokens) {
    for (const entry of PAYMENT_KEYWORDS) {
      if (entry.words.includes(token.raw)) return entry.method;
    }
  }
  return null;
}

/**
 * "The money is still owed" — said without naming a figure.
 *
 * "baaki hai", "pending hai", "udhaar", "poora dena baaki hai": the amount is
 * not stated because it is obvious to both people standing there — it is the
 * whole bill. `extractAmounts` only ever attaches an outstanding word to a
 * *number*, so with no number spoken it found nothing, and a sentence that says
 * in plain words that nothing was paid fell through to "no payment mentioned,
 * assume paid in full". That is the exact opposite of what was said, and it
 * settles a khata the shopkeeper still needs to collect on.
 *
 * Only consulted when no figure was found. "300 diya aur 120 baaki" already
 * says everything, and this must not override it.
 */
function saysNothingWasPaid(tokens: Token[]): boolean {
  return tokens.some((token) => OUTSTANDING_WORDS.includes(token.raw));
}

/* ----------------------------------------------------------------- Amounts */

type Amounts = {
  total: number | null;
  paid: number | null;
  outstanding: number | null;
  /** Token indexes claimed as money, so item extraction skips them. */
  consumedIndexes: Set<number>;
};

/**
 * Classifies each number by the words around it.
 *
 * Hinglish puts the marker *after* the amount ("120 baaki hai") and English
 * puts it before ("pending 120"), so both directions are searched, nearest
 * marker wins.
 */
function extractAmounts(tokens: Token[], ambiguities: string[]): Amounts {
  const consumedIndexes = new Set<number>();
  let total: number | null = null;
  let paid: number | null = null;
  let outstanding: number | null = null;

  const WINDOW = 3;
  const CURRENCY_WORDS = ['rupaye', 'rupees', 'rs', 'rupee', 'रुपये', 'रुपए', 'रूपये', 'টাকা', 'ரூபாய்', 'రూపాయలు', 'ರೂಪಾಯಿ'];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.value === null) continue;

    // A number immediately before a unit is a quantity, not money.
    const next = tokens[i + 1];
    if (next && UNIT_LEXICON[next.raw] !== undefined) continue;

    // …and so is a number immediately before a product ("2 chawal").
    if (next && PRODUCT_LEXICON[next.raw] !== undefined) continue;

    const nearby: string[] = [];
    for (let j = Math.max(0, i - WINDOW); j <= Math.min(tokens.length - 1, i + WINDOW); j += 1) {
      if (j !== i) nearby.push(tokens[j]!.raw);
    }

    const hasCurrency = nearby.some((word) => CURRENCY_WORDS.includes(word));

    /**
     * Each amount belongs to whichever marker is *closest* to it.
     *
     * In "100 diya 50 baaki hai" both markers sit inside the window of both
     * numbers. Asking only "is there an outstanding word nearby?" made the
     * first number the outstanding one and handed the customer's ₹100 payment
     * to the wrong column — the two figures came out swapped. Distance is what
     * a listener actually uses: the word next to the number is the word about
     * that number.
     *
     * Ties fall to "still owed", which stays the more specific claim.
     */
    const distanceTo = (words: readonly string[]): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let j = Math.max(0, i - WINDOW); j <= Math.min(tokens.length - 1, i + WINDOW); j += 1) {
        if (j === i) continue;
        if (words.includes(tokens[j]!.raw)) best = Math.min(best, Math.abs(j - i));
      }
      return best;
    };

    const outstandingDistance = distanceTo(OUTSTANDING_WORDS);
    const totalDistance = distanceTo(TOTAL_WORDS);
    const paidDistance = Math.min(
      distanceTo(PAID_WORDS),
      distanceTo(PAYMENT_KEYWORDS.flatMap((entry) => entry.words)),
    );

    const nearest = Math.min(outstandingDistance, totalDistance, paidDistance);
    const isOutstanding = Number.isFinite(outstandingDistance) && outstandingDistance === nearest;
    const isTotal =
      !isOutstanding && Number.isFinite(totalDistance) && totalDistance === nearest;
    const isPaid = !isOutstanding && !isTotal && Number.isFinite(paidDistance);

    if (isOutstanding && outstanding === null) {
      outstanding = token.value;
      consumedIndexes.add(i);
    } else if (isTotal && total === null) {
      total = token.value;
      consumedIndexes.add(i);
    } else if (isPaid && paid === null) {
      paid = token.value;
      consumedIndexes.add(i);
    } else if (hasCurrency && paid === null && token.value >= 5) {
      // A bare rupee amount with no verb is most often what was handed over.
      paid = token.value;
      consumedIndexes.add(i);
      ambiguities.push(`We read ₹${token.value} as the amount paid — please check.`);
    }
  }

  return { total, paid, outstanding, consumedIndexes };
}

/* ------------------------------------------------------------------- Items */

/**
 * Quantity and unit sitting around a product word.
 *
 * `explicit` records whether a number was actually heard, as opposed to the
 * default of one. That distinction is what lets an unrecognised word be judged:
 * "3 bread" is somebody asking for bread, "bread" on its own is a noun that may
 * just as easily be part of a sentence.
 */
function quantityAround(
  tokens: Token[],
  index: number,
  span: number,
  consumed: Set<number>,
): { quantity: number; unit: string; explicit: boolean; explicitBefore: boolean } {
  let quantity = 1;
  let unit = 'unit';
  let explicit = false;
  let explicitBefore = false;

  // Backwards: "[quantity] [unit] <product>".
  const before = tokens[index - 1];
  const twoBefore = tokens[index - 2];

  if (before && UNIT_LEXICON[before.raw] !== undefined) {
    unit = UNIT_LEXICON[before.raw]!;
    if (twoBefore?.value != null && !consumed.has(twoBefore.index)) {
      quantity = twoBefore.value;
      explicit = true;
      explicitBefore = true;
    }
  } else if (before?.value != null && !consumed.has(before.index)) {
    quantity = before.value;
    explicit = true;
    explicitBefore = true;
  }

  // Forwards: "rice 2 kg", and "3 tea packets" — the unit trails the product.
  const after = tokens[index + span];
  const twoAfter = tokens[index + span + 1];

  if (!explicit && after?.value != null && !consumed.has(after.index)) {
    const afterUnit = twoAfter ? UNIT_LEXICON[twoAfter.raw] : undefined;
    if (afterUnit) {
      quantity = after.value;
      unit = afterUnit;
      explicit = true;
    }
  }

  // A trailing unit with the quantity already found in front: "3 tea packets".
  if (unit === 'unit' && after && UNIT_LEXICON[after.raw] !== undefined) {
    unit = UNIT_LEXICON[after.raw]!;
  }

  return { quantity, unit, explicit, explicitBefore };
}

function extractItems(
  tokens: Token[],
  context: LocalParseContext,
  consumed: Set<number>,
  customerName: string | null,
): ExtractedItem[] {
  const catalogue = buildCatalogue(context.productNames ?? []);
  const items: ExtractedItem[] = [];
  const usedProductIndexes = new Set<number>();

  // The customer's own name is never a product, however it is quantified.
  const customerWords = new Set(
    (customerName ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );

  for (let i = 0; i < tokens.length; i += 1) {
    if (usedProductIndexes.has(i)) continue;
    const token = tokens[i]!;

    // Try a two-word product first ("cooking oil") then a single word.
    const twoWord = tokens[i + 1] ? `${token.raw} ${tokens[i + 1]!.raw}` : '';
    const twoWordMatch = twoWord ? catalogue.exact.get(twoWord) : undefined;
    const singleMatch = catalogue.exact.get(token.raw);

    // Spelled differently but said the same — "साल्ट" for Salt.
    const twoWordSound =
      twoWordMatch || singleMatch ? undefined : soundAlikeProduct(catalogue, twoWord);
    const singleSound =
      twoWordMatch || singleMatch || twoWordSound
        ? undefined
        : soundAlikeProduct(catalogue, token.raw);

    const productName = twoWordMatch ?? singleMatch ?? twoWordSound ?? singleSound;
    const span = productName && (twoWordMatch || twoWordSound) ? 2 : 1;

    const { quantity, unit, explicitBefore } = quantityAround(tokens, i, span, consumed);

    let name: string;

    if (productName) {
      name = productName;
    } else {
      /**
       * Something was asked for that this shop does not stock.
       *
       * Dropping it here is what made a two-item request look like a one-item
       * one: the sentence was parsed to the end, but only words the catalogue
       * recognised ever reached the draft, so "milk aur bread" silently became
       * "milk". The shopkeeper is the one who should decide what to do about an
       * item they do not carry, and they cannot decide about something they are
       * never shown.
       *
       * The bar for treating an unknown word as a product is a quantity
       * standing immediately *before* it — the "3 bread" shape. A number that
       * follows is not enough: "Sold 3 kg rice" would otherwise make a product
       * out of "sold". Known catalogue words are still recognised in either
       * order; this stricter rule applies only to words nothing recognises,
       * where a wrong guess invents a product out of a verb.
       */
      if (!explicitBefore) continue;
      if (isKnownWord(token.raw)) continue;
      if (token.value !== null) continue;
      if (customerWords.has(token.raw)) continue;
      if (token.raw.length < 2) continue;

      name = capitalise(token.raw);
    }

    for (let j = i; j < i + span; j += 1) usedProductIndexes.add(j);

    items.push({
      name,
      quantity: quantity > 0 ? quantity : 1,
      unit,
      // Prices come from the catalogue, never from guessing at speech.
      unitPriceRupees: null,
    });
  }

  return dedupe(items);
}

type Catalogue = {
  /** Spelled exactly as the lexicon or the catalogue has it. */
  exact: Map<string, string>;
  /** Keyed by how the word sounds. `null` where two products collide. */
  bySound: Map<string, string | null>;
};

/**
 * The product a phrase sounds like, or nothing.
 *
 * A last resort, reached only once every exact spelling has failed, and fenced
 * on three sides because the skeleton it compares is deliberately coarse.
 *
 * Only Devanagari is considered. That is the failure this exists for — a Hindi
 * recogniser spelling an English noun in its own script — and it is also the
 * only script the transliteration can read. Letting Latin words in was worse
 * than useless: "there" reduces to the same skeleton as "toor", so a greeting
 * put a kilo of dal on the bill. English words that are not products vastly
 * outnumber the ones that are.
 *
 * Grammar words are refused even in Devanagari, because some of them are also
 * products: "चाहिए" — "is needed", the verb ending most spoken orders — sounds
 * like "चाय", tea.
 *
 * A single-letter skeleton is refused last of all. "टी" reduces to "t", which
 * would match whichever product on the shelf happens to start with one.
 */
function soundAlikeProduct(catalogue: Catalogue, phrase: string): string | undefined {
  if (!phrase || !hasDevanagari(phrase)) return undefined;

  const words = phrase.split(' ');
  if (words.some(isKnownWord) || !words.every(hasDevanagari)) return undefined;

  const key = phoneticKey(phrase);
  if (key.length < 2) return undefined;

  return catalogue.bySound.get(key) ?? undefined;
}

/** Lexicon plus the shop's own catalogue, so local products are recognised. */
function buildCatalogue(productNames: readonly string[]): Catalogue {
  const map = new Map<string, string>(Object.entries(PRODUCT_LEXICON));

  /**
   * Sound-alike keys, so a product is recognised however its name is spelled.
   *
   * Hindi dictation writes English nouns in Devanagari — "salt" comes back as
   * "साल्ट" — and a word the catalogue does not recognise is not treated as a
   * product at all unless a quantity happens to sit in front of it.
   *
   * A skeleton shared by two products is dropped rather than resolved: a coin
   * toss between two items is worse than not recognising the word, which at
   * least leaves it on the draft for the shopkeeper to see.
   */
  const bySound = new Map<string, string | null>();
  for (const [word, canonical] of map) {
    const key = phoneticKey(word);
    if (!key) continue;
    const seen = bySound.get(key);
    bySound.set(key, seen === undefined || seen === canonical ? canonical : null);
  }

  for (const name of productNames) {
    const key = name.toLowerCase().trim();
    if (key) map.set(key, name);
    const firstWord = key.split(/\s+/)[0];
    if (firstWord && firstWord.length > 2 && !map.has(firstWord)) map.set(firstWord, name);

    for (const part of [name, firstWord ?? '']) {
      const sound = phoneticKey(part);
      if (!sound) continue;
      const seen = bySound.get(sound);
      bySound.set(sound, seen === undefined || seen === name ? name : null);
    }
  }

  return { exact: map, bySound };
}

/** "2 kg rice and 1 kg rice" is one line of 3 kg, not two lines. */
function dedupe(items: ExtractedItem[]): ExtractedItem[] {
  const merged = new Map<string, ExtractedItem>();
  for (const item of items) {
    const key = `${item.name}|${item.unit}`;
    const existing = merged.get(key);
    if (existing) existing.quantity += item.quantity;
    else merged.set(key, { ...item });
  }
  return [...merged.values()];
}

/* ------------------------------------------------------------------ Shared */

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
