use crate::error::ValidationIssue;

pub const POSTGRES_IDENTIFIER_LIMIT: usize = 63;

pub fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

pub fn normalize_identifier(input: &str) -> Result<String, ValidationIssue> {
    let mut output = String::new();
    let mut last_was_underscore = false;

    for character in input.trim().chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_lowercase());
            last_was_underscore = false;
        } else if character == '_' || character == '-' || character.is_ascii_whitespace() {
            if !output.is_empty() && !last_was_underscore {
                output.push('_');
                last_was_underscore = true;
            }
        } else {
            return Err(ValidationIssue::new(
                "",
                "invalid_identifier_character",
                format!("identifier contains unsupported character `{character}`"),
            ));
        }
    }

    while output.ends_with('_') {
        output.pop();
    }

    if output.is_empty() {
        return Err(ValidationIssue::new(
            "",
            "empty_identifier",
            "identifier must contain at least one alphanumeric character",
        ));
    }

    if !output
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
    {
        return Err(ValidationIssue::new(
            "",
            "identifier_must_start_with_letter",
            "identifier must start with an ASCII letter",
        ));
    }

    if is_reserved_identifier(&output) {
        return Err(ValidationIssue::new(
            "",
            "reserved_identifier",
            format!("identifier `{output}` is reserved"),
        ));
    }

    Ok(output)
}

fn is_reserved_identifier(identifier: &str) -> bool {
    // This catches common footguns before materialization. DDL still quotes all
    // physical identifiers, so this list is a structured validation aid rather
    // than the only SQL-safety barrier.
    matches!(
        identifier,
        "all"
            | "alter"
            | "and"
            | "any"
            | "as"
            | "asc"
            | "between"
            | "by"
            | "case"
            | "cast"
            | "check"
            | "constraint"
            | "create"
            | "current_user"
            | "default"
            | "delete"
            | "desc"
            | "distinct"
            | "drop"
            | "else"
            | "end"
            | "except"
            | "exists"
            | "false"
            | "for"
            | "foreign"
            | "from"
            | "group"
            | "having"
            | "in"
            | "insert"
            | "intersect"
            | "into"
            | "is"
            | "join"
            | "key"
            | "limit"
            | "not"
            | "null"
            | "on"
            | "or"
            | "order"
            | "primary"
            | "references"
            | "returning"
            | "select"
            | "set"
            | "session_user"
            | "table"
            | "then"
            | "true"
            | "union"
            | "unique"
            | "update"
            | "user"
            | "using"
            | "values"
            | "when"
            | "where"
            | "with"
    )
}

pub fn bounded_physical_identifier(identifier: &str) -> String {
    if identifier.len() <= POSTGRES_IDENTIFIER_LIMIT {
        return identifier.to_string();
    }

    let hash = fnv1a64_hex(identifier.as_bytes());
    let prefix_len = POSTGRES_IDENTIFIER_LIMIT - hash.len() - 1;
    let prefix_end = identifier
        .char_indices()
        .map(|(index, character)| index + character.len_utf8())
        .take_while(|end| *end <= prefix_len)
        .last()
        .unwrap_or(0);

    format!("{}_{}", &identifier[..prefix_end], hash)
}

fn fnv1a64_hex(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_identifiers_to_stable_ascii_shape() {
        assert_eq!(
            normalize_identifier(" Record Level ").unwrap(),
            "record_level"
        );
        assert_eq!(normalize_identifier("job-family").unwrap(), "job_family");
    }

    #[test]
    fn rejects_identifiers_that_do_not_have_a_valid_logical_shape() {
        assert_eq!(
            normalize_identifier("123_model").unwrap_err().code,
            "identifier_must_start_with_letter"
        );
        assert_eq!(
            normalize_identifier("model.id").unwrap_err().code,
            "invalid_identifier_character"
        );
        assert_eq!(
            normalize_identifier("select").unwrap_err().code,
            "reserved_identifier"
        );
        assert_eq!(
            normalize_identifier("current-user").unwrap_err().code,
            "reserved_identifier"
        );
        assert_eq!(
            normalize_identifier("default").unwrap_err().code,
            "reserved_identifier"
        );
    }

    #[test]
    fn bounds_physical_identifiers_with_deterministic_hash_suffix() {
        let input = "a".repeat(80);
        let bounded = bounded_physical_identifier(&input);
        assert_eq!(bounded.len(), POSTGRES_IDENTIFIER_LIMIT);
        assert_eq!(bounded, bounded_physical_identifier(&input));
        assert_ne!(bounded, input);
    }

    #[test]
    fn bounds_physical_identifiers_without_slicing_inside_utf8_codepoints() {
        let input = "é".repeat(80);
        let bounded = bounded_physical_identifier(&input);

        assert!(bounded.len() <= POSTGRES_IDENTIFIER_LIMIT);
        assert!(bounded.ends_with(&bounded_physical_identifier(&input)[bounded.len() - 16..]));
    }
}
