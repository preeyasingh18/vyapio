import { describe, expect, it } from 'vitest';
import {
  devanagariToLatin,
  hasDevanagari,
  matchKey,
  phoneticKey,
  soundsLike,
} from '../src/utils/transliterate';

/**
 * Reading English product names written in Devanagari.
 *
 * A Hindi recogniser spells English nouns in its own script: ask it for salt
 * and it returns "साल्ट", which matches neither the catalogue's "Salt" nor its
 * Hindi alias "नमक". The shop had forty kilos of salt on the shelf and the
 * draft said NOT AVAILABLE.
 *
 * None of this is ever displayed — it exists only to bring two spellings of one
 * word close enough together to compare — so the tests are about what matches,
 * and just as much about what must not.
 */

describe('spotting Devanagari', () => {
  it('sees it', () => {
    expect(hasDevanagari('साल्ट')).toBe(true);
    expect(hasDevanagari('2 किलो salt')).toBe(true);
  });

  it('does not see it where there is none', () => {
    expect(hasDevanagari('2 kg salt')).toBe(false);
    expect(hasDevanagari('')).toBe(false);
  });
});

describe('romanising', () => {
  it('drops the inherent vowel at the end of a word', () => {
    // "salta" would match nothing. This is the whole bug in one assertion.
    expect(devanagariToLatin('साल्ट')).toBe('salt');
  });

  it('reads the English nouns a Hindi recogniser hands back', () => {
    expect(devanagariToLatin('मिल्क')).toBe('milk');
    expect(devanagariToLatin('शुगर')).toBe('shugar');
    expect(devanagariToLatin('कॉफी')).toBe('kofi');
  });

  it('leaves other scripts where they are, since one sentence mixes both', () => {
    expect(devanagariToLatin('2 किलो salt')).toBe('2 kilo salt');
  });
});

describe('a key that ignores spelling', () => {
  it('collapses the vowels transliterations disagree about', () => {
    expect(matchKey('साल्ट')).toBe(matchKey('Salt'));
    expect(matchKey('saalt')).toBe(matchKey('salt'));
  });

  it('keeps different words apart', () => {
    expect(matchKey('Salt')).not.toBe(matchKey('Sugar'));
  });
});

describe('words that sound the same', () => {
  it('pairs the two spellings of a product name', () => {
    for (const [spoken, stocked] of [
      ['साल्ट', 'Salt'],
      ['मिल्क', 'Milk'],
      ['राइस', 'Rice'],
      ['शुगर', 'Sugar'],
      ['बिस्किट', 'Biscuits'],
      ['कॉफी', 'Coffee'],
    ] as const) {
      expect(soundsLike(spoken, stocked), `${spoken} ~ ${stocked}`).toBe(true);
    }
  });

  it('tolerates a plural on either side', () => {
    // The shopkeeper says "biscuit"; the label says "Biscuits".
    expect(soundsLike('biscuit', 'Biscuits')).toBe(true);
    expect(soundsLike('Biscuits', 'biscuit')).toBe(true);
  });

  it('refuses two products that merely look similar', () => {
    // Selling sugar to someone who asked for salt is worse than not
    // understanding them.
    expect(soundsLike('Salt', 'Sugar')).toBe(false);
    expect(soundsLike('Rice', 'Milk')).toBe(false);
    expect(soundsLike('Tea', 'Dal')).toBe(false);
    expect(soundsLike('Soap', 'Sugar')).toBe(false);
  });

  it('never matches on nothing', () => {
    // Two words that reduce to no letters are not the same word; matching them
    // would pair every unrecognised symbol with every other.
    expect(soundsLike('', 'Salt')).toBe(false);
    expect(soundsLike('123', '!!')).toBe(false);
  });
});

describe('the skeleton itself', () => {
  it('survives the spellings English uses for one sound', () => {
    expect(phoneticKey('Coffee')).toBe(phoneticKey('कॉफी'));
    expect(phoneticKey('phone')).toBe(phoneticKey('fone'));
  });

  it('treats v and w alike, as Devanagari and Indian English both do', () => {
    expect(phoneticKey('wheat')).toBe(phoneticKey('व्हीट'));
  });
});
