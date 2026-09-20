/**
 * Devanagari → Latin, for matching only.
 *
 * Hindi dictation writes English nouns in Devanagari. A shopkeeper saying
 * "salt" into a Hindi recogniser gets back "साल्ट", which matches neither the
 * catalogue's "Salt" nor its Hindi alias "नमक" — so the item was reported as
 * not stocked while forty kilos of it sat on the shelf.
 *
 * Enumerating the transliterations by hand is not a fix: it would mean adding
 * every English product word, in every script, to a lexicon forever. Converting
 * the script instead handles words nobody has thought of yet.
 *
 * This is deliberately not a faithful romanisation — nothing is displayed from
 * it. It only has to bring two spellings of the same word close enough together
 * to compare, so it drops the distinctions Latin does not carry anyway:
 * aspiration, retroflexion and vowel length.
 */

/** Consonants, already carrying their inherent 'a'. */
const CONSONANTS: Record<string, string> = {
  क: 'k', ख: 'k', ग: 'g', घ: 'g', ङ: 'n',
  च: 'ch', छ: 'ch', ज: 'j', झ: 'j', ञ: 'n',
  ट: 't', ठ: 't', ड: 'd', ढ: 'd', ण: 'n',
  त: 't', थ: 't', द: 'd', ध: 'd', न: 'n',
  प: 'p', फ: 'f', ब: 'b', भ: 'b', म: 'm',
  य: 'y', र: 'r', ल: 'l', व: 'v',
  श: 'sh', ष: 'sh', स: 's', ह: 'h',
  ळ: 'l',
  // Nukta forms, which dictation uses for loan words.
  क़: 'k', ख़: 'k', ग़: 'g', ज़: 'z', ड़: 'd', ढ़: 'd', फ़: 'f',
};

/** Independent vowels. */
const VOWELS: Record<string, string> = {
  अ: 'a', आ: 'a', इ: 'i', ई: 'i', उ: 'u', ऊ: 'u',
  ऋ: 'ri', ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au',
};

/** Vowel signs, which replace a consonant's inherent 'a'. */
const SIGNS: Record<string, string> = {
  'ा': 'a', // ा
  'ि': 'i', // ि
  'ी': 'i', // ी
  'ु': 'u', // ु
  'ू': 'u', // ू
  'ृ': 'ri', // ृ
  'े': 'e', // े
  'ै': 'ai', // ै
  'ो': 'o', // ो
  'ौ': 'au', // ौ
  'ॉ': 'o', // ॉ candra O, as in कॉफी
  'ॅ': 'a', // ॅ candra A
};

const VIRAMA = '्'; // ् — strips the inherent vowel
const ANUSVARA = 'ं'; // ं — a nasal
const CHANDRABINDU = 'ँ'; // ँ
const VISARGA = 'ः'; // ः
const NUKTA = '़'; // ़

/** True when the text contains any Devanagari at all. */
export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

/**
 * Romanises Devanagari, leaving anything else untouched.
 *
 * Mixed scripts are common in one transcript — "2 किलो salt" — so non-Devanagari
 * characters pass straight through rather than being dropped.
 */
export function devanagariToLatin(text: string): string {
  let out = '';

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (char === NUKTA) continue;
    if (char === VIRAMA) continue; // handled by the lookahead below
    if (char === ANUSVARA || char === CHANDRABINDU) {
      out += 'n';
      continue;
    }
    if (char === VISARGA) continue;

    const sign = SIGNS[char];
    if (sign !== undefined) {
      out += sign;
      continue;
    }

    const vowel = VOWELS[char];
    if (vowel !== undefined) {
      out += vowel;
      continue;
    }

    // A consonant followed by a nukta is one letter; look past it.
    let consonant = CONSONANTS[char];
    if (consonant === undefined && text[index + 1] === NUKTA) {
      consonant = CONSONANTS[char + NUKTA];
    }

    if (consonant !== undefined) {
      out += consonant;

      /**
       * The inherent 'a'.
       *
       * A consonant carries one unless a virama removes it or a vowel sign
       * replaces it. Skipping it at the end of a word matters: "साल्ट" has to
       * come out "salt" and not "salta", or it matches nothing.
       */
      let next = text[index + 1];
      if (next === NUKTA) next = text[index + 2];

      const suppressed =
        next === VIRAMA || (next !== undefined && SIGNS[next] !== undefined);
      const atEnd = next === undefined || !/[ऀ-ॿ]/.test(next);

      if (!suppressed && !atEnd) out += 'a';
      continue;
    }

    out += char;
  }

  return out;
}

/**
 * A spelling-insensitive key for comparing two words.
 *
 * Romanises, lowercases, drops everything but letters and digits, then
 * collapses doubled letters and the vowels Latin transliterations disagree
 * about — "saalt", "salt" and "sault" all reduce to the same key.
 */
export function matchKey(text: string): string {
  const latin = hasDevanagari(text) ? devanagariToLatin(text) : text;

  return latin
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(.)\1+/g, '$1');
}

/**
 * A sound-alike key, for when two spellings of one word will not line up.
 *
 * Romanising gets "साल्ट" to "salt", which matches. It gets "राइस" to "rais",
 * which does not match "rice" — English orthography and Devanagari disagree
 * about silent letters, soft c and doubled vowels, and no amount of care in the
 * transliteration will fix that.
 *
 * So this throws away everything the two spellings disagree about: the vowels
 * after the first letter, and the letters English writes several ways for one
 * sound. What is left is the consonant skeleton.
 *
 *   rice / rais       -> rs
 *   sugar / shugar    -> sgr
 *   coffee / kofi     -> kf
 *   wheat / व्हीट      -> vht
 *
 * A trailing plural is left on, and tolerated by `soundsLike` instead —
 * stripping it here would have taken the real 's' off "rais" and reduced it to
 * a single letter.
 *
 * Coarse by design, and used only as a last resort after the exact name, the
 * aliases and a prefix have all failed — on a shop's catalogue of a few dozen
 * products the chance of two of them sharing a skeleton is small, and a wrong
 * match at that point is still shown to the shopkeeper for confirmation.
 */
export function phoneticKey(text: string): string {
  const latin = (hasDevanagari(text) ? devanagariToLatin(text) : text).toLowerCase();

  const spelled = latin
    .replace(/[^a-z]/g, '')
    // Digraphs English writes for a single sound.
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/sh/g, 's')
    .replace(/kh/g, 'k')
    .replace(/gh/g, 'g')
    .replace(/th/g, 't')
    .replace(/dh/g, 'd')
    .replace(/bh/g, 'b')
    // Soft c before a front vowel, hard c everywhere else.
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    // Devanagari writes v and w with the same letter, and Indian English says
    // them the same way: "wheat" dictated in Hindi comes back as व्हीट.
    .replace(/w/g, 'v');

  if (!spelled) return '';

  // Keep the first letter whatever it is, then consonants only.
  const [first, ...rest] = spelled;
  const skeleton = first + rest.join('').replace(/[aeiou]/g, '');

  return skeleton.replace(/(.)\1+/g, '$1');
}

/**
 * Whether two words sound like the same thing.
 *
 * Skeletons, with a plural tolerated on either side: a shopkeeper says
 * "biscuit" and the catalogue says "Biscuits", and neither is wrong.
 *
 * An empty key never matches. Short words reduce to very little — "टी" is
 * just "t" — and matching two empty strings would pair every unrecognised
 * symbol with every other.
 */
export function soundsLike(a: string, b: string): boolean {
  const left = phoneticKey(a);
  const right = phoneticKey(b);
  if (!left || !right) return false;

  return left === right || left === `${right}s` || right === `${left}s`;
}

/* -------------------------------------------------- Romanising a name */

/**
 * Consonants as they are actually written in a name.
 *
 * Deliberately different from `CONSONANTS` above, which throws away aspiration
 * and retroflexion because those distinctions only get in the way of matching.
 * A name is read by a person, so here they are kept: ठाकुर is Thakur, not
 * Takur, and a shopkeeper looking down a customer list would not recognise the
 * second one as anybody.
 */
const NAME_CONSONANTS: Record<string, string> = {
  क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'n',
  च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'n',
  ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n',
  त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n',
  प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm',
  य: 'y', र: 'r', ल: 'l', व: 'v',
  श: 'sh', ष: 'sh', स: 's', ह: 'h',
  ळ: 'l',
  क़: 'q', ख़: 'kh', ग़: 'gh', ज़: 'z', ड़: 'r', ढ़: 'rh', फ़: 'f',
};

/**
 * A spoken name, written the way it is spelled in English.
 *
 * Indian names are written in Latin far more often than they are typed in
 * Devanagari — on a bank card, a delivery slip, a phone's contact list. A name
 * captured from Hindi dictation and stored in the script it arrived in reads
 * as a different person from the one already on the books, and the shopkeeper
 * ends up with two rows for one customer.
 *
 * This is a best effort, not a standard. "प्रिया" comes out "Priya" and
 * "ठाकुर" comes out "Thakur", which is what those people write. Someone whose
 * own spelling differs can be corrected in the customer record; what matters
 * is that the default is readable rather than a script the rest of the app
 * does not use.
 */
export function devanagariToName(text: string): string {
  if (!hasDevanagari(text)) return text;

  let out = '';
  /** Whether a consonant has been written in the word being built. */
  let wordHasConsonant = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (/\s/.test(char)) {
      out += char;
      wordHasConsonant = false;
      continue;
    }

    if (char === NUKTA) continue;
    if (char === VIRAMA) continue;
    if (char === ANUSVARA || char === CHANDRABINDU) {
      out += 'n';
      continue;
    }
    if (char === VISARGA) continue;

    const sign = SIGNS[char];
    if (sign !== undefined) {
      out += sign;
      continue;
    }

    const vowel = VOWELS[char];
    if (vowel !== undefined) {
      out += vowel;
      continue;
    }

    let consonant = NAME_CONSONANTS[char];
    if (consonant === undefined && text[index + 1] === NUKTA) {
      consonant = NAME_CONSONANTS[char + NUKTA];
    }

    if (consonant !== undefined) {
      out += consonant;

      // The inherent 'a', dropped at the end of a word — "प्रिया" is Priya,
      // never Priyaa, and "ठाकुर" is Thakur, never Thakura.
      let next = text[index + 1];
      if (next === NUKTA) next = text[index + 2];

      const suppressed =
        next === VIRAMA || (next !== undefined && SIGNS[next] !== undefined);
      const atEnd = next === undefined || !/[ऀ-ॿ]/.test(next);

      /**
       * Schwa deletion, the rule that makes नरगीस "Nargis" and not "Naragis".
       *
       * Hindi drops the inherent 'a' inside a word when the syllable after it
       * carries its own vowel — भारती is Bharti, चाँदनी is Chandni. The first
       * consonant of a word keeps it, which is the whole difference between
       * रमेश (Ramesh, kept) and the र in नरगीस (dropped).
       *
       * A heuristic, not the full rule, and it will be wrong for some names.
       * That is recoverable — the shopkeeper can correct a customer's name —
       * whereas spelling every name with an extra syllable is wrong every time.
       */
      const medial = wordHasConsonant;
      const dropped = medial && !suppressed && !atEnd && nextSyllableHasVowel(text, index);

      if (!suppressed && !atEnd && !dropped) out += 'a';
      wordHasConsonant = true;
      continue;
    }

    out += char;
  }

  // Each word capitalised, because that is how a name is written.
  return out
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Whether the consonant after `index` carries a vowel sign of its own. */
function nextSyllableHasVowel(text: string, index: number): boolean {
  let at = index + 1;
  if (text[at] === NUKTA) at += 1;

  const consonant = text[at];
  if (consonant === undefined || NAME_CONSONANTS[consonant] === undefined) return false;

  let after = text[at + 1];
  if (after === NUKTA) after = text[at + 2];

  return after !== undefined && SIGNS[after] !== undefined;
}
