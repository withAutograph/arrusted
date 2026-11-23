import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { DataContext, DataDefinition } from "../generated-app-runtime/data";
import {
  createIntegrationIngress,
  IntegrationIngressError,
  type ActiveIntegrationBinding,
  type IntegrationEnvelope,
  type IntegrationIdentity,
  type IntegrationIngress,
  type IntegrationIngestionResult,
} from "./index";

export type AmpersandReadProvider = "quickbooks" | "quickbooksSandbox" | "xero";
/** Signed provider subject only; payloads and signed URLs never enter authority callbacks. */
export type AmpersandReadSubject<P extends AmpersandReadProvider = AmpersandReadProvider> =
  Readonly<{
    action: "read";
    projectId: string;
    provider: P;
    consumerRef: string;
    groupRef: string;
    installationId: string;
    installationUpdateTime: string;
    object: string;
    operationId: string;
    operationTime: string;
  }>;
export type AmpersandReadEnvelope<P extends AmpersandReadProvider = AmpersandReadProvider> =
  IntegrationEnvelope & AmpersandReadSubject<P>;
export type AmpersandMappedReadRecord = Readonly<{
  mappedFields: Readonly<Record<string, unknown>>;
  /** Xero eligibility fields are transient recipe inputs, never provider storage. */
  fields?: Readonly<Record<string, unknown>>;
}>;
export type AmpersandPayloadOptions = {
  /** Required exact hostnames. Redirect destinations are checked independently. */
  allowedHosts: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  /** Trusted transport injection for fixtures; default transport pins the vetted DNS address. */
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
};
export type AmpersandReadOptions<D extends DataDefinition, P extends AmpersandReadProvider> = {
  projectId: string;
  provider: P;
  signingSecret: string;
  projection: IntegrationIngress<
    D,
    AmpersandMappedReadRecord,
    AmpersandReadEnvelope<NoInfer<P>>,
    Request
  >["projection"];
  payload: AmpersandPayloadOptions;
  nowSeconds?: () => number;
  /** Resolve from trusted installation metadata; never derive tenant/app authority from groupRef alone. */
  resolveIdentity(
    subject: AmpersandReadSubject<NoInfer<P>>,
    request: Request,
  ): Promise<Omit<IntegrationIdentity, "deliveryId">>;
  /** Fetch exact current installation and verify project/provider/tenant/app/route/consumer authority. */
  verifyBinding(
    identity: IntegrationIdentity,
    subject: AmpersandReadSubject<NoInfer<P>>,
    request: Request,
  ): Promise<ActiveIntegrationBinding>;
  withBindingLease<T>(
    identity: IntegrationIdentity,
    run: (binding: ActiveIntegrationBinding) => Promise<T>,
  ): Promise<T>;
  createDataContext(binding: ActiveIntegrationBinding): DataContext;
};

export class AmpersandReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "AmpersandReadError";
  }
}
const MAX_PAYLOAD_BYTES = 1024 * 1024;
type ParsedRead<P extends AmpersandReadProvider> = {
  subject: AmpersandReadSubject<P>;
  resultInfo: { type: "inline" | "url"; numRecords?: number; downloadUrl?: string };
  result: unknown;
};

/** Fixed read ingress mechanics. No provider mutations, raw retention, or app schema inference. */
export function createAmpersandReadIngress<
  D extends DataDefinition,
  P extends AmpersandReadProvider,
>(
  options: AmpersandReadOptions<D, P>,
): (rawBody: Uint8Array, request: Request) => Promise<IntegrationIngestionResult> {
  if (typeof window !== "undefined") throw new Error("Ampersand read ingress is server-only");
  requiredText(options.projectId);
  if (!["quickbooks", "quickbooksSandbox", "xero"].includes(options.provider))
    reject(503, "ampersand_configuration_invalid");
  const key = signingKey(options.signingSecret);
  const payloadOptions = { ...options.payload, allowedHosts: [...options.payload.allowedHosts] };
  if (
    !payloadOptions.allowedHosts.every(
      (host) => typeof host === "string" && host.trim() && !/[/*:@]/u.test(host),
    )
  )
    reject(503, "ampersand_configuration_invalid");
  if (
    payloadOptions.maxBytes !== undefined &&
    (!Number.isSafeInteger(payloadOptions.maxBytes) ||
      payloadOptions.maxBytes < 1 ||
      payloadOptions.maxBytes > MAX_PAYLOAD_BYTES)
  )
    reject(503, "ampersand_configuration_invalid");
  if (
    payloadOptions.timeoutMs !== undefined &&
    (!Number.isSafeInteger(payloadOptions.timeoutMs) || payloadOptions.timeoutMs < 1)
  )
    reject(503, "ampersand_configuration_invalid");
  return async (rawBody, request) => {
    try {
      const raw = Uint8Array.from(rawBody);
      if (raw.byteLength === 0 || raw.byteLength > MAX_PAYLOAD_BYTES)
        reject(413, "ampersand_envelope_size_invalid");
      const messageId = verifySignature(raw, request.headers, key, options.nowSeconds);
      const parsed = parseRead(raw, options);
      const resolved = await options.resolveIdentity(parsed.subject, request);
      const identity: IntegrationIdentity = Object.freeze({
        appId: resolved.appId,
        customerId: resolved.customerId,
        bindingId: resolved.bindingId,
        connectionId: resolved.connectionId,
        routingId: resolved.routingId,
        deliveryId: `ampersand:${createHash("sha256")
          .update(
            JSON.stringify([
              parsed.subject.projectId,
              parsed.subject.installationId,
              "read",
              parsed.subject.operationId,
              parsed.subject.object,
              messageId,
            ]),
          )
          .digest("hex")}`,
      });
      const envelope = Object.freeze({ ...parsed.subject, identity });
      const ingress = createIntegrationIngress<
        D,
        AmpersandMappedReadRecord,
        AmpersandReadEnvelope<P>,
        Request
      >({
        projection: options.projection,
        // Signature proof above binds these owned bytes. The generic ingress takes
        // another owned copy; authenticate it against the exact verified bytes.
        verifySignature: async (bytes) => {
          if (bytes.length !== raw.length || !timingSafeEqual(bytes, raw))
            reject(401, "ampersand_signature_invalid");
        },
        parseEnvelope: () => envelope,
        verifyBinding: (current) => options.verifyBinding(current, parsed.subject, request),
        readPayload: async () => {
          if (parsed.resultInfo.numRecords === 0) {
            if (parsed.result != null && recordsFromResult(parsed.result).length !== 0)
              reject(400, "ampersand_record_count_mismatch");
            return Buffer.from("[]");
          }
          return parsed.resultInfo.type === "url"
            ? downloadPayload(parsed.resultInfo.downloadUrl!, payloadOptions)
            : raw;
        },
        parseRecords: (bytes) => {
          const value = parseJson(bytes);
          const records =
            parsed.resultInfo.numRecords === 0
              ? recordsFromResult(value)
              : recordsFromResult(
                  parsed.resultInfo.type === "inline" ? record(value).result : value,
                );
          if (
            parsed.resultInfo.numRecords !== undefined &&
            records.length !== parsed.resultInfo.numRecords
          )
            reject(400, "ampersand_record_count_mismatch");
          return records.map((value) => {
            const entry = record(value);
            return {
              mappedFields: record(entry.mappedFields),
              ...(entry.fields === undefined ? {} : { fields: record(entry.fields) }),
            };
          });
        },
        withBindingLease: (current, run) => options.withBindingLease(current, run),
        createDataContext: (current) => options.createDataContext(current),
      });
      return await ingress(raw, request);
    } catch (error) {
      if (error instanceof AmpersandReadError || error instanceof IntegrationIngressError)
        throw error;
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const status =
        error && typeof error === "object" && "status" in error ? error.status : undefined;
      if (
        status === 401 ||
        status === 403 ||
        ["forbidden", "invalid_grant", "not_verified", "not_found"].includes(String(code))
      )
        reject(403, "ampersand_authority_denied");
      if (status === 409 || code === "conflict") reject(409, "ampersand_binding_changed");
      reject(503, "ampersand_temporarily_unavailable");
    }
  };
}

function parseRead<D extends DataDefinition, P extends AmpersandReadProvider>(
  raw: Uint8Array,
  options: AmpersandReadOptions<D, P>,
): ParsedRead<P> {
  const input = record(parseJson(raw));
  if (input.action !== "read") reject(400, "ampersand_action_unsupported");
  if (input.projectId !== options.projectId || input.provider !== options.provider)
    reject(403, "ampersand_provider_scope_mismatch");
  const object = requiredText(input.objectName);
  const projections = Object.values(options.projection.recipe.projections) as readonly {
    object: string | readonly string[];
  }[];
  const supported = projections.some(
    (projection) =>
      projection &&
      (typeof projection.object === "string" ? [projection.object] : projection.object).includes(
        object,
      ),
  );
  if (!supported) reject(400, "ampersand_object_unsupported");
  const subject: AmpersandReadSubject<P> = Object.freeze({
    action: "read",
    projectId: options.projectId,
    provider: options.provider,
    object,
    consumerRef: requiredText(input.consumerRef),
    groupRef: requiredText(input.groupRef),
    installationId: requiredText(input.installationId),
    installationUpdateTime: timestamp(input.installationUpdateTime),
    operationId: requiredText(input.operationId),
    operationTime: timestamp(input.operationTime),
  });
  const info = record(input.resultInfo);
  if (info.type !== "inline" && info.type !== "url") reject(400, "ampersand_result_invalid");
  if ("url" in info || "resultUrl" in info || (info.type === "inline" && "downloadUrl" in info))
    reject(400, "ampersand_result_invalid");
  if (
    info.numRecords !== undefined &&
    (!Number.isSafeInteger(info.numRecords) || Number(info.numRecords) < 0)
  )
    reject(400, "ampersand_result_invalid");
  return {
    subject,
    resultInfo: {
      type: info.type,
      ...(info.numRecords === undefined ? {} : { numRecords: Number(info.numRecords) }),
      ...(info.type === "url" ? { downloadUrl: requiredText(info.downloadUrl, 16384) } : {}),
    },
    result: input.result,
  };
}
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return reject(400, "ampersand_json_invalid");
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    reject(400, "ampersand_result_invalid");
  return value as Record<string, unknown>;
}
function recordsFromResult(value: unknown): unknown[] {
  const result = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (value as { result?: unknown }).result
      : undefined;
  if (!Array.isArray(result)) reject(400, "ampersand_result_invalid");
  return result;
}
function requiredText(value: unknown, maxLength = 1024): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    reject(400, "ampersand_envelope_invalid");
  return value;
}
function timestamp(value: unknown): string {
  const text = requiredText(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text) ||
    !Number.isFinite(Date.parse(text))
  )
    reject(400, "ampersand_timestamp_invalid");
  return text;
}

// Extracted from Vendor's shared Svix mechanics. Authenticate the exact byte sequence.
function signingKey(secret: string): Buffer {
  if (typeof secret !== "string") reject(503, "ampersand_signing_configuration_invalid");
  const normalized = secret
    .trim()
    .replace(/^whsec_/u, "")
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized))
    reject(503, "ampersand_signing_configuration_invalid");
  const decoded = Buffer.from(normalized, "base64");
  if (
    !decoded.length ||
    decoded.toString("base64").replace(/=+$/u, "") !== normalized.replace(/=+$/u, "")
  )
    reject(503, "ampersand_signing_configuration_invalid");
  return decoded;
}
function verifySignature(
  raw: Uint8Array,
  headers: Headers,
  key: Buffer,
  now?: () => number,
): string {
  const id = headers.get("svix-id"),
    timestamp = headers.get("svix-timestamp"),
    signature = headers.get("svix-signature");
  if (!id || !timestamp || !signature) reject(401, "ampersand_signature_missing");
  requiredText(id);
  const time = Number(timestamp);
  if (!/^\d+$/u.test(timestamp) || !Number.isSafeInteger(time))
    reject(401, "ampersand_signature_invalid");
  const currentTime = now?.() ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(currentTime)) reject(503, "ampersand_signing_configuration_invalid");
  if (Math.abs(currentTime - time) > 300) reject(401, "ampersand_signature_expired");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(raw).digest();
  for (const candidate of signature.split(/\s+/u)) {
    if (!candidate.startsWith("v1,")) continue;
    const decoded = Buffer.from(candidate.slice(3), "base64");
    if (decoded.length === expected.length && timingSafeEqual(decoded, expected)) return id;
  }
  reject(401, "ampersand_signature_invalid");
}
function reject(status: number, code: string): never {
  throw new AmpersandReadError(status, code);
}

// HTTPS payload transport extracted from Vendor shared mechanics.
const MAX_URL_PAYLOAD_BYTES = 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 10_000;
const MAX_URL_REDIRECTS = 5;

async function downloadPayload(
  initialUrl: string,
  options: AmpersandPayloadOptions,
): Promise<Uint8Array> {
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const maxBytes = options.maxBytes ?? MAX_URL_PAYLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? URL_FETCH_TIMEOUT_MS;
  let url = parseConstrainedPayloadUrl(initialUrl, allowedHosts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let activeResponse: Response | undefined;

  try {
    for (let redirectCount = 0; redirectCount <= MAX_URL_REDIRECTS; redirectCount += 1) {
      const resolvedAddress = await withPayloadDeadline(
        publicResolvedAddress(url.hostname, options.resolveHost),
        controller.signal,
        url,
      );
      let response: Response;
      try {
        response = await withPayloadDeadline(
          options.fetchImpl == null
            ? fetchWithPinnedAddress(url, resolvedAddress, {
                signal: controller.signal,
              })
            : options.fetchImpl(url, {
                redirect: "manual",
                signal: controller.signal,
              }),
          controller.signal,
          url,
        );
        activeResponse = response;
      } catch {
        if (controller.signal.aborted) {
          throw payloadTimeoutError(url);
        }
        throw httpError(
          502,
          "ampersand_payload_fetch_failed",
          `Payload URL fetch failed: ${redactUrl(url)}`,
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw httpError(
            502,
            "ampersand_payload_redirect_missing_location",
            `Payload URL redirect is missing a Location header: ${redactUrl(url)}`,
          );
        }
        url = parseConstrainedPayloadUrl(new URL(location, url).toString(), allowedHosts);
        await response.body?.cancel().catch(() => undefined);
        continue;
      }

      if (!response.ok) {
        throw httpError(
          502,
          "ampersand_payload_fetch_failed",
          `Payload URL fetch failed with status ${response.status}: ${redactUrl(url)}`,
        );
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength != null && Number(contentLength) > maxBytes) {
        throw httpError(
          413,
          "ampersand_payload_too_large",
          `Payload URL response exceeds ${maxBytes} bytes: ${redactUrl(url)}`,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!isJsonContentType(contentType)) {
        throw httpError(
          415,
          "ampersand_payload_not_json",
          `Payload URL response is not JSON: ${redactUrl(url)}`,
        );
      }
      const rawBytes = await boundedResponseBytes(response, maxBytes, url, controller.signal);
      try {
        JSON.parse(bytesToUtf8(rawBytes));
      } catch {
        throw httpError(
          502,
          "ampersand_payload_invalid_json",
          `Payload URL response is not valid JSON: ${redactUrl(url)}`,
        );
      }
      return rawBytes;
    }

    throw httpError(
      502,
      "ampersand_payload_redirect_loop",
      `Payload URL exceeded ${MAX_URL_REDIRECTS} redirects: ${redactUrl(url)}`,
    );
  } finally {
    clearTimeout(timeout);
    if (activeResponse?.body && !activeResponse.body.locked)
      void activeResponse.body.cancel().catch(() => undefined);
  }
}

type PublicResolvedAddress = {
  address: string;
  family: 4 | 6;
};

async function fetchWithPinnedAddress(
  url: URL,
  resolvedAddress: PublicResolvedAddress,
  options: { signal: AbortSignal },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        servername: url.hostname,
        headers: { accept: "application/json" },
        signal: options.signal,
        lookup: (_hostname, _options, callback) => {
          callback(null, resolvedAddress.address, resolvedAddress.family);
        },
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
          } else if (value != null) {
            headers.set(name, value);
          }
        }
        const status = incoming.statusCode;
        if (status == null || status < 200 || status > 599) {
          incoming.destroy();
          reject(
            httpError(
              502,
              "ampersand_payload_fetch_failed",
              `Payload URL fetch returned an invalid status: ${redactUrl(url)}`,
            ),
          );
          return;
        }
        try {
          const bodyless = [204, 205, 304].includes(status);
          if (bodyless) incoming.destroy();
          resolve(
            new Response(bodyless ? null : (Readable.toWeb(incoming) as ReadableStream), {
              status,
              headers,
            }),
          );
        } catch {
          incoming.destroy();
          reject(new AmpersandReadError(502, "ampersand_payload_fetch_failed"));
        }
      },
    );
    request.on("error", (error) => {
      if (options.signal.aborted) {
        reject(payloadTimeoutError(url));
        return;
      }
      reject(error);
    });
    request.end();
  });
}

function payloadTimeoutError(url: URL): AmpersandReadError {
  return httpError(
    504,
    "ampersand_payload_timeout",
    `Payload URL fetch timed out: ${redactUrl(url)}`,
  );
}

function withPayloadDeadline<T>(task: Promise<T>, signal: AbortSignal, url: URL): Promise<T> {
  if (signal.aborted) return Promise.reject(payloadTimeoutError(url));
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(payloadTimeoutError(url));
    };
    signal.addEventListener("abort", abort, { once: true });
    void task.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  url: URL,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted === true) {
    return Promise.reject(payloadTimeoutError(url));
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      void reader.cancel();
      reject(payloadTimeoutError(url));
    };
    signal?.addEventListener("abort", abort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener("abort", abort));
  });
}

async function publicResolvedAddress(
  hostname: string,
  resolveHost: AmpersandPayloadOptions["resolveHost"],
): Promise<PublicResolvedAddress> {
  const addresses = resolveHost
    ? await resolveHost(hostname)
    : await lookup(hostname, { all: true }).then((entries) =>
        entries.map((entry) => entry.address),
      );
  for (const address of addresses) {
    if (hostIsPrivateAddress(address)) {
      throw httpError(
        400,
        "ampersand_payload_private_host",
        `Payload URL resolves to a private network address: ${hostname}`,
      );
    }
  }
  const address = addresses[0];
  const family = address == null ? 0 : isIP(address);
  if (address == null || (family !== 4 && family !== 6)) {
    throw httpError(
      400,
      "ampersand_payload_host_not_resolved",
      `Payload URL host did not resolve to a public IP address: ${hostname}`,
    );
  }
  return { address, family };
}

function parseConstrainedPayloadUrl(rawUrl: string, allowedHosts: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, "ampersand_payload_url_invalid", "Payload URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw httpError(400, "ampersand_payload_url_non_https", "Payload URL must use HTTPS");
  }
  if (url.port) {
    throw httpError(
      400,
      "ampersand_payload_url_port",
      "Payload URL must use the default HTTPS port",
    );
  }
  if (url.username || url.password) {
    throw httpError(400, "ampersand_payload_url_userinfo", "Payload URL must not contain userinfo");
  }
  if (!hostMatchesAllowedHost(url.hostname, allowedHosts)) {
    throw httpError(
      400,
      "ampersand_payload_host_not_allowed",
      `Payload URL host is not allowed: ${redactUrl(url)}`,
    );
  }
  if (hostIsPrivateAddress(url.hostname)) {
    throw httpError(
      400,
      "ampersand_payload_private_host",
      `Payload URL resolves to a private network host: ${redactUrl(url)}`,
    );
  }
  return url;
}

function hostMatchesAllowedHost(host: string, allowedHosts: ReadonlySet<string>): boolean {
  const normalizedHost = normalizeHost(host);
  for (const allowedHost of allowedHosts) {
    const normalizedAllowedHost = normalizeHost(allowedHost);
    if (normalizedHost === normalizedAllowedHost) {
      return true;
    }
  }
  return false;
}

function hostIsPrivateAddress(host: string): boolean {
  const normalizedHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const version = isIP(normalizedHost);
  if (version === 4) {
    const parts = normalizedHost.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const normalized = normalizedHost.toLowerCase();
    const mapped = ipv4MappedIpv6Address(normalized);
    if (mapped != null) return hostIsPrivateAddress(mapped);
    // Public provider DNS must resolve to global unicast IPv6. Reject compatible,
    // translated and otherwise reserved ranges as well as local/private ranges.
    const firstWord = Number.parseInt(normalized.split(":")[0] ?? "", 16);
    if (!Number.isInteger(firstWord) || (firstWord & 0xe000) !== 0x2000) return true;
    const words = normalizedIpv6Words(normalized);
    if (words != null && words.slice(0, 7).every((word) => word === 0) && words[7] === 1) {
      return true;
    }
    const firstGroup = normalized.split(":")[0];
    const firstGroupNumber = firstGroup == null ? Number.NaN : Number.parseInt(firstGroup, 16);
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      (firstGroupNumber >= 0xfe80 && firstGroupNumber <= 0xfebf) ||
      normalized.startsWith("fec") ||
      normalized.startsWith("fed") ||
      normalized.startsWith("fee") ||
      normalized.startsWith("fef") ||
      normalized.startsWith("ff")
    );
  }
  return false;
}

function ipv4MappedIpv6Address(normalizedHost: string): string | null {
  const normalized = ipv6WithEmbeddedDottedQuadAsHex(normalizedHost);
  const words = normalizedIpv6Words(normalized);
  if (words == null) return null;
  if (words.slice(0, 5).some((word) => word !== 0) || words[5] !== 0xffff) {
    return null;
  }
  const high = words[6];
  const low = words[7];
  if (high == null || low == null) return null;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function normalizedIpv6Words(normalizedHost: string): number[] | null {
  const parts = normalizedHost.split("::");
  if (parts.length > 2) return null;
  const head = parts[0]?.split(":").filter(Boolean) ?? [];
  const tail = parts[1]?.split(":").filter(Boolean) ?? [];
  const groups =
    parts.length === 1
      ? head
      : [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => "0"), ...tail];
  if (groups.length !== 8) return null;
  const words = groups.map((group) => Number.parseInt(group, 16));
  if (words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return null;
  }
  return words;
}

function ipv6WithEmbeddedDottedQuadAsHex(normalizedHost: string): string {
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(normalizedHost);
  if (embedded?.[2] == null || isIP(embedded[2]) !== 4) {
    return normalizedHost;
  }
  const octets = embedded[2].split(".").map(Number);
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  const high = ((a << 8) | b).toString(16);
  const low = ((c << 8) | d).toString(16);
  return `${embedded[1]}${high}:${low}`;
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\.$/, "").toLowerCase();
}

async function boundedResponseBytes(
  response: Response,
  maxBytes: number,
  url: URL,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (response.body == null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw httpError(
        413,
        "ampersand_payload_too_large",
        `Payload URL response exceeds ${maxBytes} bytes: ${redactUrl(url)}`,
      );
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const read = await readWithAbort(reader, signal, url);
      if (read.done) break;
      total += read.value.byteLength;
      if (total > maxBytes) {
        throw httpError(
          413,
          "ampersand_payload_too_large",
          `Payload URL response exceeds ${maxBytes} bytes: ${redactUrl(url)}`,
        );
      }
      chunks.push(read.value);
    }
    return concatBytes(...chunks);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function redactUrl(url: URL): string {
  return `${url.protocol}//${url.host}/[redacted]`;
}

function httpError(status: number, code: string, _message: string): AmpersandReadError {
  return new AmpersandReadError(status, code);
}
