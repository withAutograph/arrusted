use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

const USAGE: &str = "Usage: schema-compiler [--raw | --app-artifact | --data-plane | --sql-manifest | --sql-bundle | --sql-transition-plan | --schema-transition-contract] [--expression <expression>] [--schema-version <version>] [--compiled-artifact <artifact.json> [--previous-compiled-artifact <artifact.json>]... [--previous-sql-manifest <sql-manifest.json>]] <input.cue|data.json>...";

fn main() -> ExitCode {
    match run(env::args_os().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("schema-compiler: {}", error.message);
            ExitCode::from(error.exit_code)
        }
    }
}

fn run(arguments: Vec<OsString>) -> Result<(), CliError> {
    let options = Options::parse(arguments)?;
    if let Some(path) = &options.compiled_artifact {
        return run_compiled_artifact(
            path,
            &options.previous_compiled_artifact,
            options.previous_sql_manifest.as_deref(),
            options.output,
        );
    }
    if options.inputs.is_empty() {
        return Err(CliError::usage());
    }

    let imported_data = ImportedData::new(&options.inputs)?;
    let cue_inputs = options
        .inputs
        .iter()
        .map(|input| {
            imported_data
                .cue_path(input)
                .unwrap_or_else(|| input.clone())
        })
        .collect::<Vec<_>>();

    let cue_output = Command::new("cue")
        .arg("export")
        .args(cue_inputs)
        .arg("-e")
        .arg(&options.expression)
        .args(["--out", "json"])
        .output()
        .map_err(|error| CliError::runtime(format!("failed to run `cue`: {error}")))?;

    if !cue_output.status.success() {
        let stderr = String::from_utf8_lossy(&cue_output.stderr);
        let detail = stderr.trim();
        let message = if detail.is_empty() {
            format!("`cue export` failed with {}", cue_output.status)
        } else {
            format!("`cue export` failed with {}:\n{detail}", cue_output.status)
        };
        return Err(CliError::runtime(message));
    }

    let mut manifest_json = String::from_utf8(cue_output.stdout).map_err(|error| {
        CliError::runtime(format!("`cue export` produced non-UTF-8 JSON: {error}"))
    })?;
    // Build identity is an explicit compiler input, before normalization, SQL and hashes.
    if let Some(version) = &options.schema_version {
        let mut manifest: serde_json::Value = serde_json::from_str(&manifest_json)
            .map_err(|error| CliError::runtime(format!("invalid manifest JSON: {error}")))?;
        let object = manifest
            .as_object_mut()
            .ok_or_else(|| CliError::runtime("manifest must be an object".to_string()))?;
        object.insert(
            "version".to_string(),
            serde_json::Value::String(version.clone()),
        );
        manifest_json = serde_json::to_string(&manifest)
            .map_err(|error| CliError::runtime(error.to_string()))?;
    }
    if options.output == OutputMode::Raw {
        let output =
            serde_json::from_str::<serde_json::Value>(&manifest_json).map_err(|error| {
                CliError::runtime(format!(
                    "CUE expression did not produce valid JSON: {error}"
                ))
            })?;
        print_json(&output)?;
        return Ok(());
    }

    if options.output == OutputMode::AppArtifact {
        let artifact = schema_compiler::compile_app_artifact_json(&manifest_json)
            .map_err(|error| CliError::runtime(format!("manifest compilation failed: {error}")))?;
        let output = serde_json::to_value(artifact).map_err(|error| {
            CliError::runtime(format!("failed to serialize the compiler output: {error}"))
        })?;
        return print_json(&output);
    }

    let compiled = schema_compiler::compile_manifest_json(&manifest_json)
        .map_err(|error| CliError::runtime(format!("manifest compilation failed: {error}")))?;
    if options.output == OutputMode::DataPlane {
        return print_json(
            &schema_compiler::data_plane::compile(&compiled).map_err(|error| {
                CliError::runtime(format!("data-plane compilation failed: {error}"))
            })?,
        );
    }
    if options.output == OutputMode::SqlBundle {
        let manifest = schema_compiler::compile_sql_artifact_manifest(&compiled)
            .map_err(|error| CliError::runtime(format!("SQL compilation failed: {error}")))?;
        print!("{}", schema_compiler::render_sql_artifact_bundle(&manifest));
        return Ok(());
    }

    let output = match options.output {
        OutputMode::CompiledManifest => serde_json::to_value(compiled),
        OutputMode::AppArtifact => unreachable!("handled above"),
        OutputMode::SqlManifest
        | OutputMode::SqlTransitionPlan
        | OutputMode::SchemaTransitionContract => {
            let manifest = schema_compiler::compile_sql_artifact_manifest(&compiled)
                .map_err(|error| CliError::runtime(format!("SQL compilation failed: {error}")))?;
            serde_json::to_value(manifest)
        }
        OutputMode::DataPlane | OutputMode::Raw | OutputMode::SqlBundle => {
            unreachable!("handled above")
        }
    }
    .map_err(|error| {
        CliError::runtime(format!("failed to serialize the compiler output: {error}"))
    })?;
    print_json(&output)
}

fn run_compiled_artifact(
    path: &Path,
    previous_paths: &[PathBuf],
    previous_sql_manifest: Option<&Path>,
    output: OutputMode,
) -> Result<(), CliError> {
    if output == OutputMode::Raw {
        return Err(CliError::usage());
    }
    let compiled = read_compiled_artifact(path)?;
    if output == OutputMode::DataPlane {
        let predecessors = previous_paths
            .iter()
            .map(|path| read_artifact_predecessor(path))
            .collect::<Result<Vec<_>, CliError>>()?;
        return print_json(
            &schema_compiler::data_plane::compile_with_predecessors(&compiled, &predecessors)
                .map_err(|error| {
                    CliError::runtime(format!("data-plane compilation failed: {error}"))
                })?,
        );
    }
    if output == OutputMode::AppArtifact {
        let artifact: schema_compiler::CompiledAppArtifact = compiled.clone().into();
        let output = serde_json::to_value(artifact).map_err(|error| {
            CliError::runtime(format!("failed to serialize the compiler output: {error}"))
        })?;
        return print_json(&output);
    }
    if let Some(previous_sql_manifest) = previous_sql_manifest {
        let previous = read_artifact_predecessor(&previous_paths[0])?;
        let bytes = fs::read(previous_sql_manifest).map_err(|error| {
            CliError::runtime(format!(
                "failed to read previous SQL manifest {}: {error}",
                previous_sql_manifest.display()
            ))
        })?;
        let checked_sql = serde_json::from_slice(&bytes).map_err(|error| {
            CliError::runtime(format!(
                "invalid previous SQL manifest {}: {error}",
                previous_sql_manifest.display()
            ))
        })?;
        let (plan, online) =
            schema_compiler::compile_online_sql_transition_plan(&previous, &checked_sql, &compiled)
                .map_err(|error| CliError::runtime(format!("SQL compilation failed: {error}")))?;
        let mut value = serde_json::to_value(plan).map_err(|error| {
            CliError::runtime(format!("failed to serialize the compiler output: {error}"))
        })?;
        if let Some(online) = online {
            value["online_optional_text_addition"] =
                serde_json::to_value(online).map_err(|error| {
                    CliError::runtime(format!("failed to serialize the compiler output: {error}"))
                })?;
        }
        return print_json(&value);
    }
    let previous = previous_paths
        .iter()
        .map(|path| read_compiled_artifact(path))
        .collect::<Result<Vec<_>, _>>()?;
    if output == OutputMode::SchemaTransitionContract {
        let contract = schema_compiler::compile_schema_transition_contract(&previous, &compiled)
            .map_err(|error| CliError::runtime(format!("SQL compilation failed: {error}")))?;
        let output = serde_json::to_value(contract).map_err(|error| {
            CliError::runtime(format!("failed to serialize the compiler output: {error}"))
        })?;
        return print_json(&output);
    }
    let manifest =
        schema_compiler::compile_sql_materialization_plan(previous.first(), &compiled)
            .map_err(|error| CliError::runtime(format!("SQL compilation failed: {error}")))?;
    if output == OutputMode::SqlBundle {
        if !previous.is_empty() {
            return Err(CliError::runtime(
                "--previous-compiled-artifact is only valid with --sql-transition-plan".to_string(),
            ));
        }
        print!("{}", schema_compiler::render_sql_artifact_bundle(&manifest));
        return Ok(());
    }
    let output = serde_json::to_value(manifest).map_err(|error| {
        CliError::runtime(format!("failed to serialize the compiler output: {error}"))
    })?;
    print_json(&output)
}

fn read_compiled_artifact(path: &Path) -> Result<schema_compiler::CompiledManifest, CliError> {
    parse_compiled_artifact(path, &read_compiled_artifact_bytes(path)?)
}

fn read_artifact_predecessor(
    path: &Path,
) -> Result<schema_compiler::data_plane::DataPlanePredecessor, CliError> {
    let bytes = read_compiled_artifact_bytes(path)?;
    Ok(schema_compiler::data_plane::DataPlanePredecessor {
        artifact_sha256: Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        compiled: parse_compiled_artifact(path, &bytes)?,
    })
}

fn read_compiled_artifact_bytes(path: &Path) -> Result<Vec<u8>, CliError> {
    fs::read(path).map_err(|error| {
        CliError::runtime(format!(
            "failed to read compiled artifact {}: {error}",
            path.display()
        ))
    })
}

fn parse_compiled_artifact(
    path: &Path,
    input: &[u8],
) -> Result<schema_compiler::CompiledManifest, CliError> {
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum ArtifactInput {
        Compiled(schema_compiler::CompiledManifest),
        App(schema_compiler::CompiledAppArtifact),
        Legacy {
            schema: kernel::Schema,
            extras: schema_compiler::NormalizedManifestExtras,
        },
        Historical {
            schema: kernel::Schema,
        },
    }
    let artifact = serde_json::from_slice::<ArtifactInput>(input).map_err(|error| {
        CliError::runtime(format!(
            "invalid compiled artifact {}: {error}",
            path.display()
        ))
    })?;
    Ok(match artifact {
        ArtifactInput::Compiled(compiled) => compiled,
        ArtifactInput::App(app) => schema_compiler::CompiledManifest {
            schema: app.schema,
            extras: app.extras,
        },
        ArtifactInput::Legacy { schema, extras } => {
            schema_compiler::CompiledManifest { schema, extras }
        }
        ArtifactInput::Historical { schema } => schema_compiler::CompiledManifest {
            schema,
            extras: schema_compiler::NormalizedManifestExtras {
                model_metadata: Vec::new(),
                field_metadata: Vec::new(),
                inverse_relations: Vec::new(),
                many_relations: Vec::new(),
                constraints: Vec::new(),
                derived_fields: Vec::new(),
                authorization_policy: None,
                seed_change_sets: Vec::new(),
            },
        },
    })
}

fn print_json(output: &serde_json::Value) -> Result<(), CliError> {
    let normalized = serde_json::to_string_pretty(&output).map_err(|error| {
        CliError::runtime(format!("failed to serialize compiler output: {error}"))
    })?;

    println!("{normalized}");
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OutputMode {
    CompiledManifest,
    DataPlane,
    Raw,
    AppArtifact,
    SqlManifest,
    SqlBundle,
    SqlTransitionPlan,
    SchemaTransitionContract,
}

struct Options {
    output: OutputMode,
    expression: OsString,
    schema_version: Option<String>,
    inputs: Vec<PathBuf>,
    compiled_artifact: Option<PathBuf>,
    previous_compiled_artifact: Vec<PathBuf>,
    previous_sql_manifest: Option<PathBuf>,
}

impl Options {
    fn parse(arguments: Vec<OsString>) -> Result<Self, CliError> {
        let mut output = OutputMode::CompiledManifest;
        let mut output_was_selected = false;
        let mut expression = OsString::from("manifest");
        let mut schema_version = None;
        let mut inputs = Vec::new();
        let mut compiled_artifact = None;
        let mut previous_compiled_artifact = Vec::new();
        let mut previous_sql_manifest = None;
        let mut arguments = arguments.into_iter();
        while let Some(argument) = arguments.next() {
            match argument.to_str() {
                Some("--raw") => {
                    select_output(&mut output, &mut output_was_selected, OutputMode::Raw)?
                }
                Some("--data-plane") => {
                    select_output(&mut output, &mut output_was_selected, OutputMode::DataPlane)?
                }
                Some("--app-artifact") => select_output(
                    &mut output,
                    &mut output_was_selected,
                    OutputMode::AppArtifact,
                )?,
                Some("--sql-manifest") => select_output(
                    &mut output,
                    &mut output_was_selected,
                    OutputMode::SqlManifest,
                )?,
                Some("--sql-bundle") => {
                    select_output(&mut output, &mut output_was_selected, OutputMode::SqlBundle)?
                }
                Some("--sql-transition-plan") => select_output(
                    &mut output,
                    &mut output_was_selected,
                    OutputMode::SqlTransitionPlan,
                )?,
                Some("--schema-transition-contract") => select_output(
                    &mut output,
                    &mut output_was_selected,
                    OutputMode::SchemaTransitionContract,
                )?,
                Some("--compiled-artifact") => {
                    if compiled_artifact.is_some() {
                        return Err(CliError::usage());
                    }
                    compiled_artifact =
                        Some(PathBuf::from(arguments.next().ok_or_else(CliError::usage)?));
                }
                Some("--previous-compiled-artifact") => {
                    previous_compiled_artifact
                        .push(PathBuf::from(arguments.next().ok_or_else(CliError::usage)?));
                }
                Some("--previous-sql-manifest") => {
                    if previous_sql_manifest.is_some() {
                        return Err(CliError::usage());
                    }
                    previous_sql_manifest =
                        Some(PathBuf::from(arguments.next().ok_or_else(CliError::usage)?));
                }
                Some("--schema-version") => {
                    if schema_version.is_some() {
                        return Err(CliError::usage());
                    }
                    let value = arguments.next().ok_or_else(CliError::usage)?;
                    let value = value.into_string().map_err(|_| CliError::usage())?;
                    if value.trim().is_empty() {
                        return Err(CliError::usage());
                    }
                    schema_version = Some(value);
                }
                Some("--expression") => {
                    expression = arguments.next().ok_or_else(CliError::usage)?;
                }
                Some(value) if value.starts_with('-') => return Err(CliError::usage()),
                _ => inputs.push(PathBuf::from(argument)),
            }
        }
        if compiled_artifact.is_some() && (!inputs.is_empty() || schema_version.is_some()) {
            return Err(CliError::usage());
        }
        if !previous_compiled_artifact.is_empty()
            && (compiled_artifact.is_none()
                || !matches!(
                    output,
                    OutputMode::SqlTransitionPlan
                        | OutputMode::SchemaTransitionContract
                        | OutputMode::DataPlane
                ))
        {
            return Err(CliError::usage());
        }
        if previous_sql_manifest.is_some()
            && (output != OutputMode::SqlTransitionPlan || previous_compiled_artifact.len() != 1)
        {
            return Err(CliError::usage());
        }
        Ok(Self {
            output,
            expression,
            schema_version,
            inputs,
            compiled_artifact,
            previous_compiled_artifact,
            previous_sql_manifest,
        })
    }
}

fn select_output(
    output: &mut OutputMode,
    selected: &mut bool,
    requested: OutputMode,
) -> Result<(), CliError> {
    if *selected {
        return Err(CliError::usage());
    }
    *output = requested;
    *selected = true;
    Ok(())
}

struct ImportedData {
    _directory: Option<TemporaryDirectory>,
    mappings: Vec<(PathBuf, PathBuf)>,
}

impl ImportedData {
    fn new(inputs: &[PathBuf]) -> Result<Self, CliError> {
        let data_inputs = inputs
            .iter()
            .filter(|input| input.extension().and_then(|value| value.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        if data_inputs.is_empty() {
            return Ok(Self {
                _directory: None,
                mappings: Vec::new(),
            });
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| CliError::runtime(format!("system clock error: {error}")))?
            .as_nanos();
        let directory =
            env::temp_dir().join(format!("schema-compiler-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&directory).map_err(|error| {
            CliError::runtime(format!("failed to create temporary CUE directory: {error}"))
        })?;
        let temporary_directory = TemporaryDirectory(directory.clone());

        let mut mappings = Vec::new();
        for (index, input) in data_inputs.into_iter().enumerate() {
            let output = Command::new("cue")
                .args(["import", "-p", "schema", "-o", "-"])
                .arg(input)
                .output()
                .map_err(|error| {
                    CliError::runtime(format!("failed to run `cue import`: {error}"))
                })?;
            if !output.status.success() {
                return Err(CliError::runtime(format!(
                    "`cue import` failed for {}: {}",
                    input.display(),
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
            let cue_path = directory.join(format!("data-{index}.cue"));
            fs::write(&cue_path, output.stdout).map_err(|error| {
                CliError::runtime(format!("failed to write temporary CUE data: {error}"))
            })?;
            mappings.push(((*input).clone(), cue_path));
        }
        Ok(Self {
            _directory: Some(temporary_directory),
            mappings,
        })
    }

    fn cue_path(&self, input: &Path) -> Option<PathBuf> {
        self.mappings
            .iter()
            .find(|(source, _)| source == input)
            .map(|(_, cue)| cue.clone())
    }
}

struct TemporaryDirectory(PathBuf);

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct CliError {
    exit_code: u8,
    message: String,
}

impl CliError {
    fn usage() -> Self {
        Self {
            exit_code: 2,
            message: USAGE.to_string(),
        }
    }

    fn runtime(message: String) -> Self {
        Self {
            exit_code: 1,
            message,
        }
    }
}
