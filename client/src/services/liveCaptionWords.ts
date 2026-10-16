// Language-specific word data for splitting live captions at a length cut. Each language has its own complete
// list; a word valid in two languages (for example the Cyrillic prepositions "на" and "для") appears in both.
// The accumulator does not know the speech language reliably, so it uses the union of the lists.

// Words that lean on the word after them (articles, prepositions, conjunctions, determiners, question words) in
// English, Ukrainian, and Russian. Personal pronouns and auxiliaries are left out: they also end clauses
// ("could be", "told her").
export const ENGLISH_DANGLING_WORDS: readonly string[] = [
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'and', 'or', 'but', 'nor',
  'that', 'which', 'who', 'whose', 'than', 'into', 'onto', 'about', 'over', 'under', 'after', 'before', 'between',
  'through', 'during', 'without', 'within', 'against', 'among', 'if', 'because', 'while', 'its', 'their', 'his',
  'our', 'my', 'your', 'this', 'these', 'those', 'every', 'each',
  'what', 'how', 'when', 'where', 'whether',
]

export const UKRAINIAN_DANGLING_WORDS: readonly string[] = [
  'і', 'й', 'та', 'а', 'але', 'або', 'чи', 'в', 'у', 'на', 'з', 'із', 'зі', 'до', 'по', 'про', 'від', 'за', 'для',
  'при', 'через', 'над', 'під', 'перед', 'між', 'без', 'після', 'що', 'щоб', 'як', 'якщо', 'коли', 'бо', 'наш',
  'наша', 'наше', 'наші', 'свій', 'своя', 'своє', 'свої', 'цей', 'ця', 'ці', 'який', 'яка', 'яке', 'які',
  'де', 'куди', 'звідки',
]

export const RUSSIAN_DANGLING_WORDS: readonly string[] = [
  'и', 'но', 'или', 'а', 'в', 'во', 'у', 'на', 'с', 'со', 'к', 'ко', 'о', 'об', 'от', 'из', 'до', 'по', 'про', 'за',
  'для', 'при', 'через', 'над', 'перед', 'без', 'между', 'после', 'чтобы', 'если', 'когда', 'потому', 'который',
  'которая', 'которое', 'которые', 'этот', 'эта', 'эти', 'наш', 'наша', 'наше', 'наши', 'свой', 'своё', 'свои',
  'что', 'как', 'под', 'где', 'куда', 'откуда',
]

export const DANGLING_WORDS: ReadonlySet<string> = new Set([
  ...ENGLISH_DANGLING_WORDS,
  ...UKRAINIAN_DANGLING_WORDS,
  ...RUSSIAN_DANGLING_WORDS,
])

// A number leans on the unit or noun after it. The digit form is language-neutral; the spelled-out forms are per
// language, with the Ukrainian and Russian ones also matching their case endings.
const NUMBER_DIGITS = String.raw`\d[\d.,]*%?`
const ENGLISH_NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion'
const UKRAINIAN_NUMBER_WORDS = String.raw`тисяч[аі]?|мільйон\p{L}*|мільярд\p{L}*`
const RUSSIAN_NUMBER_WORDS = String.raw`тысяч[аи]?|миллион\p{L}*|миллиард\p{L}*`

function wholeWord(alternatives: string): RegExp {
  return new RegExp(`^(?:${alternatives})$`, 'u')
}

export const ENGLISH_NUMBER_WORD = wholeWord(ENGLISH_NUMBER_WORDS)
export const UKRAINIAN_NUMBER_WORD = wholeWord(UKRAINIAN_NUMBER_WORDS)
export const RUSSIAN_NUMBER_WORD = wholeWord(RUSSIAN_NUMBER_WORDS)
export const NUMBER_WORD = wholeWord([NUMBER_DIGITS, ENGLISH_NUMBER_WORDS, UKRAINIAN_NUMBER_WORDS, RUSSIAN_NUMBER_WORDS].join('|'))
