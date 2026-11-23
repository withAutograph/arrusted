//! Typed expression AST shared by the schema compiler, the generated SQL
//! runtime, and generated TypeScript contracts. Raw SQL is never an input.

use serde::{Deserialize, Serialize};

use crate::contracts::MoneyRatePeriod;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConstraintExpr {
    And {
        expressions: Vec<ConstraintExpr>,
    },
    Or {
        expressions: Vec<ConstraintExpr>,
    },
    Not {
        expression: Box<ConstraintExpr>,
    },
    FieldPresent {
        field: String,
    },
    FieldAbsent {
        field: String,
    },
    CountPresent {
        fields: Vec<String>,
        #[serde(default)]
        min: Option<u32>,
        #[serde(default)]
        max: Option<u32>,
    },
    CompareFields {
        left: String,
        op: Comparison,
        right: String,
    },
    CompareLiteral {
        field: String,
        op: Comparison,
        value: TypedLiteral,
    },
    FieldIn {
        field: String,
        values: Vec<TypedLiteral>,
    },
    FieldSetContains {
        field: String,
        value: String,
    },
    TextLength {
        field: String,
        #[serde(default)]
        min: Option<usize>,
        #[serde(default)]
        max: Option<usize>,
    },
    TextStartsWith {
        field: String,
        value: String,
    },
    /// Cross-record rule: live rows that share every field of one `subjects`
    /// tuple must not have overlapping inclusive `[start, end]` date
    /// intervals. An absent `end` is open. Valid only as the root expression
    /// of an entity-model constraint; it lowers to generated write-path
    /// enforcement rather than a row CHECK.
    NonOverlappingIntervals {
        start: String,
        end: String,
        subjects: Vec<Vec<String>>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Comparison {
    Eq,
    NotEq,
    Lt,
    Lte,
    Gt,
    Gte,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum TypedLiteral {
    Text(String),
    Number(String),
    Bool(bool),
    Date(String),
    Datetime(String),
    Enum(String),
    IsoCountry(String),
    IsoCurrency(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum DerivedExpr {
    Field {
        field: String,
    },
    RelationField {
        relation: String,
        field: String,
    },
    Literal {
        value: TypedLiteral,
    },
    Coalesce {
        expressions: Vec<DerivedExpr>,
    },
    Concat {
        expressions: Vec<DerivedExpr>,
    },
    Add {
        left: Box<DerivedExpr>,
        right: Box<DerivedExpr>,
    },
    Subtract {
        left: Box<DerivedExpr>,
        right: Box<DerivedExpr>,
    },
    Multiply {
        left: Box<DerivedExpr>,
        right: Box<DerivedExpr>,
    },
    Divide {
        left: Box<DerivedExpr>,
        right: Box<DerivedExpr>,
    },
    InverseAggregate {
        inverse_relation: String,
        aggregate: Aggregate,
        #[serde(default)]
        expression: Option<Box<DerivedExpr>>,
        #[serde(default)]
        filter: Option<ConstraintExpr>,
    },
    NormalizeMoneyRate {
        expression: Box<DerivedExpr>,
        period: MoneyRatePeriod,
    },
    /// A named working-session rule parameter. Derived fields reject it.
    Parameter {
        parameter: String,
    },
    /// Boolean comparison of two operands of one type.
    Compare {
        op: Comparison,
        left: Box<DerivedExpr>,
        right: Box<DerivedExpr>,
    },
    /// `then` when the boolean condition is true, otherwise `else`
    /// (including when the condition is null).
    If {
        condition: Box<DerivedExpr>,
        #[serde(rename = "then")]
        then_expression: Box<DerivedExpr>,
        #[serde(rename = "else")]
        else_expression: Box<DerivedExpr>,
    },
    Min {
        left: Box<DerivedExpr>,
        right: Box<DerivedExpr>,
    },
    Max {
        left: Box<DerivedExpr>,
        right: Box<DerivedExpr>,
    },
    /// `max(min, min(expression, max))`.
    Clamp {
        expression: Box<DerivedExpr>,
        min: Box<DerivedExpr>,
        max: Box<DerivedExpr>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Aggregate {
    Count,
    Sum,
    Min,
    Max,
}
