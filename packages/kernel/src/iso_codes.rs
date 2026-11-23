// ISO 3166-1 alpha-2 country codes, pinned from the ISO 3166 Maintenance Agency
// / ISO Online Browsing Platform list. Snapshot date: 2026-06-27.
const ISO_3166_1_ALPHA_2_CODES: &[&str] = &[
    "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
    "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS",
    "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
    "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE",
    "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
    "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
    "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM",
    "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC",
    "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
    "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
    "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG",
    "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
    "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS",
    "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO",
    "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
    "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
];

// ISO 4217 alpha-3 tender currency codes, mirrored from packages/engines/currency
// and excluding ISO special-purpose codes (funds, metals, test/no-currency).
// Snapshot date: 2026-06-27.
const ISO_4217_TENDER_CURRENCY_CODES: &[&str] = &[
    "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT",
    "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD",
    "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD",
    "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ",
    "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD",
    "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR",
    "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR",
    "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN",
    "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR",
    "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB",
    "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS",
    "VED", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG",
];

pub fn is_iso_3166_1_alpha_2(value: &str) -> bool {
    ISO_3166_1_ALPHA_2_CODES.binary_search(&value).is_ok()
}

pub fn is_iso_4217_tender_currency(value: &str) -> bool {
    ISO_4217_TENDER_CURRENCY_CODES.binary_search(&value).is_ok()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{ISO_3166_1_ALPHA_2_CODES, ISO_4217_TENDER_CURRENCY_CODES};

    const TS_CURRENCY_ENGINE: &str = include_str!("../../engines/currency/index.ts");
    const TS_REFERENCE_DATA_ENGINE: &str = include_str!("../../engines/reference-data/index.ts");

    #[test]
    fn country_codes_match_typescript_reference_data_engine() {
        let expected_country_codes =
            parse_exported_string_array(TS_REFERENCE_DATA_ENGINE, "ISO_3166_1_ALPHA_2_CODES");
        let rust_country_codes = ISO_3166_1_ALPHA_2_CODES
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();

        assert_eq!(rust_country_codes, expected_country_codes);
    }

    #[test]
    fn tender_currency_codes_match_typescript_currency_engine() {
        let all_codes = parse_exported_string_array(TS_CURRENCY_ENGINE, "ISO_4217_CURRENCY_CODES");
        let special_codes = parse_exported_string_array(
            TS_CURRENCY_ENGINE,
            "ISO_4217_SPECIAL_PURPOSE_CURRENCY_CODES",
        );
        let expected_tender_codes = all_codes
            .difference(&special_codes)
            .cloned()
            .collect::<BTreeSet<_>>();
        let rust_tender_codes = ISO_4217_TENDER_CURRENCY_CODES
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();

        assert_eq!(rust_tender_codes, expected_tender_codes);
    }

    fn parse_exported_string_array(source: &'static str, name: &str) -> BTreeSet<&'static str> {
        let prefix = format!("export const {name} = [");
        let start = source
            .find(&prefix)
            .unwrap_or_else(|| panic!("missing {name} export"))
            + prefix.len();
        let rest = &source[start..];
        let end = rest
            .find("] as const;")
            .unwrap_or_else(|| panic!("unterminated {name} export"));

        rest[..end]
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"'))
            .map(|line| {
                line.split_once('"')
                    .unwrap_or_else(|| panic!("invalid string entry in {name}: {line}"))
                    .0
            })
            .collect()
    }
}
