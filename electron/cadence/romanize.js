// Letters a–z (and the apostrophe) for the English letters model: Latin with its accents taken off (Vietnamese,
// Spanish, French...), kana (Hepburn), Hangul (Revised Romanisation), Cyrillic and Greek. Chinese characters have
// no reading here and give no letters (that line keeps its line time).

const KANA = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to', な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo', ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo', だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo', ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
};
const toHira = (c) => (c >= 'ァ' && c <= 'ヶ' ? String.fromCharCode(c.charCodeAt(0) - 0x60) : c);

function kana(s) {
  let out = '';
  const cs = [...s].map(toHira);
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i], nx = cs[i + 1];
    if (c === 'っ') { const r = KANA[nx] || ''; out += r ? r[0] : ''; continue; } // doubled consonant
    if (c === 'ー') { out += out.slice(-1); continue; } // long vowel
    let r = KANA[c];
    if (r == null) { out += c; continue; }
    if (nx && 'ゃゅょ'.includes(nx) && r.endsWith('i') && r.length > 1) { // きゃ kya, しゃ sha
      const y = KANA[nx];
      r = /^(shi|chi|ji)$/.test(r) ? r.slice(0, -1) + y.slice(1) : r.slice(0, -1) + y;
      i++;
    } else if (nx && 'ぁぃぅぇぉ'.includes(nx) && r.length > 1) { // ふぁ fa, てぃ ti
      r = r.slice(0, -1) + KANA[nx]; i++;
    }
    out += r;
  }
  return out;
}

// Hangul: initial, medial, final jamo
const L = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const V = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const T = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
function hangul(c) {
  const code = c.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  return L[Math.floor(code / 588)] + V[Math.floor((code % 588) / 28)] + T[code % 28];
}

const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };
const GRK = { α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o' };
const SPECIAL = { đ: 'd', ð: 'd', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', þ: 'th', ı: 'i' };

/** a–z and ' for a piece of text (spaces dropped) */
function romanize(text) {
  let s = '';
  const src = String(text).toLowerCase();
  let run = '';
  const flush = () => { if (run) { s += kana(run); run = ''; } };
  for (const ch of src) {
    if (/[぀-ヿ]/.test(ch)) { run += ch; continue; }
    flush();
    const h = hangul(ch);
    if (h != null) { s += h; continue; }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    s += SPECIAL[ch] ?? CYR[ch] ?? SPECIAL[base] ?? CYR[base] ?? GRK[base] ?? base; // й, ё before their accents go
  }
  flush();
  return s.replace(/[’‘`´]/g, "'").replace(/[^a-z']/g, '');
}

module.exports = { romanize, kana };
