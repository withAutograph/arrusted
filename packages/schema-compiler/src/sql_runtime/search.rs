//! Record search matching for `kernel_data_query`'s `search` clause.
//!
//! One rule, shared with client-side search (HC Explore): values and queries
//! are normalized (accents stripped, lowercased, whitespace trimmed and
//! collapsed), then graded exact (0) > prefix (1) > word start (2) >
//! substring (3) > fuzzy (4). Fuzzy means every query term starts a word of
//! the value, or is within an optimal-string-alignment distance (a
//! transposition counts as one edit) of a word or of the word's prefix of the
//! term's length: 0 edits for terms under 4 characters, 1 for 4-7, 2 for 8+.
//! Plain SQL and PL/pgSQL only: generated installs may not rely on extensions.
//!
//! Normalization matches JavaScript's
//! `s.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
//! .replace(/\s+/gu, " ").trim()` whatever the database locale (often `C`):
//! lowercasing uses the ICU root collation `und-x-icu` (present on every
//! ICU-enabled PostgreSQL, including Neon), which applies full Unicode case
//! mapping (Greek final sigma included) as `toLowerCase` does, and whitespace
//! is the explicit set JavaScript's `\s` matches rather than the
//! locale-dependent `\s` class.

use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    [
        ("kernel_search_normalize(text)", SEARCH_NORMALIZE),
        ("kernel_search_distance(text,text,integer)", SEARCH_DISTANCE),
        ("kernel_search_grade(text,text)", SEARCH_GRADE),
        (
            "kernel_search_record_grade(text,jsonb,jsonb)",
            SEARCH_RECORD_GRADE,
        ),
    ]
    .into_iter()
    .map(|(signature, sql)| RuntimeSqlFunction {
        signature,
        sql: sql.trim().to_string(),
    })
    .collect()
}

const SEARCH_NORMALIZE: &str = r#"
create or replace function kernel_search_normalize(value text)
returns text
language sql
immutable
strict
parallel safe
security invoker
set search_path from current
as $kernel_search$
  select nullif(btrim(regexp_replace(
    lower(regexp_replace(normalize(value, NFD), '[̀-ͯ]', '', 'g') collate "und-x-icu"),
    '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'
  )), '')
$kernel_search$
"#;

// Optimal string alignment distance, stopping once it exceeds `max_distance`
// (then returning `max_distance + 1`).
const SEARCH_DISTANCE: &str = r#"
create or replace function kernel_search_distance(a text, b text, max_distance integer)
returns integer
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path from current
as $kernel_search$
declare
  a_length integer := char_length(a);
  b_length integer := char_length(b);
  before_previous integer[];
  previous integer[];
  current_row integer[];
  row_minimum integer;
  best integer;
  a_char text;
  b_char text;
begin
  if abs(a_length - b_length) > max_distance then return max_distance + 1; end if;
  if a_length = 0 or b_length = 0 then return greatest(a_length, b_length); end if;
  previous := array(select generate_series(0, b_length));
  for i in 1..a_length loop
    current_row := array_fill(0, array[b_length + 1]);
    current_row[1] := i;
    row_minimum := i;
    a_char := substr(a, i, 1);
    for j in 1..b_length loop
      b_char := substr(b, j, 1);
      best := least(
        previous[j + 1] + 1,
        current_row[j] + 1,
        previous[j] + case when a_char = b_char then 0 else 1 end
      );
      if i > 1 and j > 1 and a_char = substr(b, j - 1, 1) and substr(a, i - 1, 1) = b_char then
        best := least(best, before_previous[j - 1] + 1);
      end if;
      current_row[j + 1] := best;
      row_minimum := least(row_minimum, best);
    end loop;
    if row_minimum > max_distance then return max_distance + 1; end if;
    before_previous := previous;
    previous := current_row;
  end loop;
  return least(previous[b_length + 1], max_distance + 1);
end;
$kernel_search$
"#;

// How a normalized value matches a normalized query: 0 exact, 1 prefix,
// 2 word start, 3 substring, 4 fuzzy, null for no match. Word characters are
// ICU's letters and digits (`und-x-icu`), so non-ASCII words split as they do
// in JavaScript (`\p{L}\p{N}`) even when the database locale is `C`.
const SEARCH_GRADE: &str = r#"
create or replace function kernel_search_grade(candidate text, query text)
returns integer
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path from current
as $kernel_search$
declare
  found_at integer;
  searched integer := 0;
  term text;
  word text;
  allowed integer;
  matched boolean;
begin
  if candidate = query then return 0; end if;
  if starts_with(candidate, query) then return 1; end if;
  found_at := strpos(candidate, query);
  if found_at > 0 then
    loop
      found_at := strpos(substr(candidate, searched + 1), query);
      exit when found_at = 0;
      found_at := found_at + searched;
      if substr(candidate, found_at - 1, 1) collate "und-x-icu" !~ '[[:alnum:]]' then return 2; end if;
      searched := found_at;
    end loop;
    return 3;
  end if;
  foreach term in array string_to_array(query, ' ') loop
    allowed := case
      when char_length(term) < 4 then 0
      when char_length(term) < 8 then 1
      else 2
    end;
    matched := false;
    foreach word in array regexp_split_to_array(candidate collate "und-x-icu", '[^[:alnum:]]+') loop
      continue when word = '';
      -- Cheap filters first: a word too short, or missing more of the
      -- term's characters than edits allow, cannot match.
      matched := starts_with(word, term) or (
        allowed > 0
        and char_length(word) >= char_length(term) - allowed
        and char_length(translate(term, word, '')) <= allowed
        and (
          kernel_search_distance(term, word, allowed) <= allowed
          or kernel_search_distance(term, left(word, char_length(term)), allowed) <= allowed
        )
      );
      exit when matched;
    end loop;
    if not matched then return null; end if;
  end loop;
  return 4;
end;
$kernel_search$
"#;

// The best grade among a record's searched values: text fields, and each
// item of list-of-text and alias fields.
const SEARCH_RECORD_GRADE: &str = r#"
create or replace function kernel_search_record_grade(query text, record_values jsonb, field_ids jsonb)
returns integer
language sql
immutable
strict
parallel safe
security invoker
set search_path from current
as $kernel_search$
  select min(kernel_search_grade(normalized.value, query))
  from jsonb_array_elements_text(field_ids) field(id)
  cross join lateral (
    select record_values->field.id->>'value' as value
    where jsonb_typeof(record_values->field.id->'value') = 'string'
    union all
    select item.value
    from jsonb_array_elements_text(
      case when jsonb_typeof(record_values->field.id->'value') = 'array'
        then record_values->field.id->'value' else '[]'::jsonb end
    ) item(value)
  ) candidate
  cross join lateral (select kernel_search_normalize(candidate.value) as value) normalized
  where normalized.value is not null
$kernel_search$
"#;
