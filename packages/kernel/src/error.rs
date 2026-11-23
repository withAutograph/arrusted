use std::error::Error as StdError;
use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Vec<ErrorDetail>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorDetail {
    pub path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelErrorDto {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Vec<ErrorDetail>,
}

impl KernelErrorDto {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Vec::new(),
        }
    }

    pub fn with_detail(
        code: impl Into<String>,
        message: impl Into<String>,
        path: impl Into<String>,
        detail_code: impl Into<String>,
        detail_message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: vec![ErrorDetail {
                path: path.into(),
                code: detail_code.into(),
                message: detail_message.into(),
            }],
        }
    }

    pub fn into_envelope(self) -> ErrorEnvelope {
        ErrorEnvelope {
            code: self.code,
            message: self.message,
            details: self.details,
        }
    }
}

impl fmt::Display for KernelErrorDto {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub path: String,
    pub code: &'static str,
    pub message: String,
}

impl ValidationIssue {
    pub fn new(path: impl Into<String>, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("contract validation failed")]
pub struct ValidationError {
    pub issues: Vec<ValidationIssue>,
}

impl ValidationError {
    pub fn new(issues: Vec<ValidationIssue>) -> Self {
        Self { issues }
    }

    pub fn into_envelope(self) -> ErrorEnvelope {
        ErrorEnvelope {
            code: "contract_validation_failed".to_string(),
            message: "Contract validation failed".to_string(),
            details: self
                .issues
                .into_iter()
                .map(|issue| ErrorDetail {
                    path: issue.path,
                    code: issue.code.to_string(),
                    message: issue.message,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Error)]
pub enum KernelError {
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error("{dto}")]
    Kernel {
        dto: KernelErrorDto,
        #[source]
        source: Option<Box<dyn StdError + Send + Sync + 'static>>,
    },
}

impl KernelError {
    pub fn from_dto(dto: KernelErrorDto) -> Self {
        Self::Kernel { dto, source: None }
    }

    pub fn from_dto_with_source(
        dto: KernelErrorDto,
        source: impl StdError + Send + Sync + 'static,
    ) -> Self {
        Self::Kernel {
            dto,
            source: Some(Box::new(source)),
        }
    }

    pub fn into_envelope(self) -> ErrorEnvelope {
        match self {
            KernelError::Validation(error) => error.into_envelope(),
            KernelError::Kernel { dto, .. } => dto.into_envelope(),
        }
    }
}
