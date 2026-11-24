/**
 * OpenTelemetry Integration for Tracing and Metrics (#676)
 *
 * Public entry point for enabling distributed tracing and metrics collection
 * across Sorokit SDK operations (wallet connection, transaction submission,
 * account lookups, and beyond).
 *
 * This module is a thin, ergonomic layer on top of the vendor-agnostic
 * OpenTelemetry-compatible engine in `../shared/openTelemetry` (spans,
 * histograms, counters, and real HTTP exporters for OTLP/Jaeger). It adds:
 *
 *  - `initTelemetry(config)` — a single call that validates configuration,
 *    selects/builds an exporter (Jaeger, Datadog, OTLP, or an in-process
 *    console/memory sink), and installs a process-wide telemetry manager.
 *  - Named instrumentation helpers for the SDK's most latency-sensitive
 *    operations (`wallet.connect`, `transaction.submit`, `account.fetch`)
 *    plus a generic `traceSpan` any module can use.
 *  - Metric recording helpers for operation duration, error rates, and
 *    cache hit/miss ratios.
 *
 * ## Zero-overhead when unconfigured
 *
 * Every helper here is safe to call unconditionally, even before
 * `initTelemetry` has run. Until a config is installed, `traceSpan` and the
 * named wrappers call straight through to the wrapped function with no span
 * allocation, and the metric recorders are no-ops. This lets other SDK
 * modules (see `wallet/connect.ts`, `transaction/submitTransaction.ts`,
 * `account/getAccount.ts`) instrument themselves unconditionally without
 * imposing cost — or a hard dependency — on consumers who never call
 * `initTelemetry`.
 *
 * ## Usage
 *
 * ```typescript
 * import { initTelemetry, traceWalletConnect } from "sorokit-core";
 *
 * initTelemetry({
 *   serviceName: "my-app",
 *   exporter: "jaeger",
 *   samplingRate: 0.1,
 * });
 *
 * // Automatic tracing of SDK operations:
 * const result = await traceWalletConnect((span) => {
 *   span?.setAttribute("wallet.adapter", "freighter");
 *   return connectWallet(adapter);
 * });
 * ```
 */

import {
  createOpenTelemetryManager,
  OpenTelemetryManager,
  OtlpHttpTelemetryExporter,
  SorokitSpan,
} from "../shared/openTelemetry";
import type {
  OpenTelemetryConfig,
  OpenTelemetryExporterType,
  OtelMetricRecord,
  OtelMetricSummary,
  SpanData,
  SpanKind,
  SpanStatusCode,
  StartSpanOptions,
  TelemetryExporter,
} from "../shared/openTelemetry";
import { generateTraceId } from "../shared/utils";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// Re-exported so consumers can type the `customExporter` field of
// {@link TelemetryConfig} without reaching into the shared internals.
export type { TelemetryExporter } from "../shared/openTelemetry";

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * Supported exporter backends. `"console"`, `"memory"`, and `"none"` are
 * local/testing sinks; `"jaeger"`, `"datadog"`, and `"otlp"` export over HTTP
 * to a real (or locally running) collector.
 */
export type TelemetryExporterType =
  | "jaeger"
  | "datadog"
  | "otlp"
  | "console"
  | "memory"
  | "none";

export interface TelemetryConfig {
  /** Logical name of the instrumented service, e.g. `"my-app"`. */
  serviceName: string;

  /** Version of the instrumented service. @default "0.1.0" */
  serviceVersion?: string | undefined;

  /**
   * Which exporter backend to send spans/metrics to.
   * @default "otlp"
   */
  exporter?: TelemetryExporterType | undefined;

  /**
   * Fraction of spans to sample, between 0 and 1 inclusive.
   * @default 1.0
   */
  samplingRate?: number | undefined;

  /**
   * Exporter endpoint. Ignored for `"console"`, `"memory"`, and `"none"`.
   * Defaults are supplied per-exporter (see {@link DEFAULT_EXPORTER_ENDPOINTS}).
   */
  endpoint?: string | undefined;

  /** Additional HTTP headers sent with every export request. */
  headers?: Record<string, string> | undefined;

  /**
   * Datadog API key. Only used when `exporter: "datadog"`; sent as the
   * `DD-API-KEY` header. Required for Datadog's public OTLP intake, but may
   * be omitted when exporting to a local Datadog Agent configured to accept
   * unauthenticated OTLP.
   */
  apiKey?: string | undefined;

  /**
   * A pre-built exporter to send spans and metrics to, taking precedence over
   * the built-in Jaeger/Datadog/OTLP/console/memory selection driven by
   * `exporter`. Use this to wire a custom backend — most notably the official
   * OpenTelemetry JS API bridge built by {@link createOtelApiExporter}, which
   * forwards SDK spans/metrics to a host-configured `TracerProvider` /
   * `MeterProvider` and on to any OTel-compatible backend. When unset, the
   * built-in exporter selected by `exporter` is used.
   */
  customExporter?: TelemetryExporter | undefined;

  /** Metrics flush interval in milliseconds. @default 10000 */
  metricsIntervalMs?: number | undefined;
}

export interface TelemetryData {
  /** Echoes the configured service name. */
  serviceName: string;
  /** Resolved service version (defaulted if not supplied). */
  serviceVersion: string;
  /** Resolved exporter backend. */
  exporter: TelemetryExporterType;
  /** Resolved sampling rate. */
  samplingRate: number;
  /** Resolved export endpoint, if applicable to the chosen exporter. */
  endpoint?: string | undefined;
  /** Unique identifier for this telemetry session, useful for correlating logs. */
  instanceId: string;
  /** Epoch ms at which telemetry was initialized. */
  initializedAt: number;
}

/** A subset of {@link SorokitSpan}'s API that instrumentation callbacks receive. */
export type TelemetrySpan = SorokitSpan;

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_EXPORTER_ENDPOINTS: Record<TelemetryExporterType, string | undefined> = {
  jaeger: "http://localhost:14268/api/traces",
  otlp: "http://localhost:4318/v1/traces",
  datadog: "https://otlp.datadoghq.com/v1/traces",
  console: undefined,
  memory: undefined,
  none: undefined,
};

const VALID_EXPORTERS: readonly TelemetryExporterType[] = [
  "jaeger",
  "datadog",
  "otlp",
  "console",
  "memory",
  "none",
];

// ─── Datadog Exporter ───────────────────────────────────────────────────────

/**
 * Exports spans and metrics to Datadog over its OTLP-compatible intake
 * (`https://otlp.datadoghq.com` by default, or a local Datadog Agent with
 * OTLP ingestion enabled). Requires no additional npm dependency — it
 * reuses the same lightweight `fetch`-based OTLP payload shape as
 * {@link OtlpHttpTelemetryExporter}, adding the `DD-API-KEY` header Datadog
 * expects for its public intake.
 *
 * If your deployment instead routes through a Datadog Agent with an
 * OTLP receiver, omit `apiKey` and point `endpoint` at the agent
 * (typically `http://localhost:4318/v1/traces`).
 */
export class DatadogHttpTelemetryExporter implements TelemetryExporter {
  private readonly delegate: OtlpHttpTelemetryExporter;

  constructor(endpoint: string, apiKey?: string, headers: Record<string, string> = {}) {
    const ddHeaders: Record<string, string> = { ...headers };
    if (apiKey) {
      ddHeaders["DD-API-KEY"] = apiKey;
    }
    this.delegate = new OtlpHttpTelemetryExporter(endpoint, ddHeaders);
  }

  public exportSpans(spans: SpanData[]): Promise<void> | void {
    return this.delegate.exportSpans(spans);
  }

  public exportMetrics(metrics: OtelMetricRecord[]): Promise<void> | void {
    return this.delegate.exportMetrics(metrics);
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validates a {@link TelemetryConfig} without side effects. Returns `null`
 * when the config is valid, or a descriptive error otherwise.
 */
export function validateTelemetryConfig(config: TelemetryConfig): string | null {
  if (!config || typeof config !== "object") {
    return "Telemetry config must be an object.";
  }
  if (typeof config.serviceName !== "string" || config.serviceName.trim().length === 0) {
    return "Telemetry config requires a non-empty `serviceName`.";
  }
  if (config.exporter !== undefined && !VALID_EXPORTERS.includes(config.exporter)) {
    return `Invalid exporter "${String(config.exporter)}". Expected one of: ${VALID_EXPORTERS.join(", ")}.`;
  }
  if (config.samplingRate !== undefined) {
    if (
      typeof config.samplingRate !== "number" ||
      Number.isNaN(config.samplingRate) ||
      config.samplingRate < 0 ||
      config.samplingRate > 1
    ) {
      return "`samplingRate` must be a number between 0 and 1 (inclusive).";
    }
  }
  if (
    config.metricsIntervalMs !== undefined &&
    (typeof config.metricsIntervalMs !== "number" || config.metricsIntervalMs <= 0)
  ) {
    return "`metricsIntervalMs` must be a positive number.";
  }
  return null;
}

/**
 * Resolves a {@link TelemetryConfig} into the {@link OpenTelemetryConfig}
 * consumed by `OpenTelemetryManager`, selecting/constructing the correct
 * exporter instance. Exported separately from `initTelemetry` so exporter
 * selection logic can be unit-tested without side effects (no manager is
 * constructed or installed).
 */
export function resolveOpenTelemetryConfig(config: TelemetryConfig): OpenTelemetryConfig {
  const exporterType: TelemetryExporterType = config.exporter ?? "otlp";
  const endpoint = config.endpoint ?? DEFAULT_EXPORTER_ENDPOINTS[exporterType];

  const base: OpenTelemetryConfig = {
    enabled: true,
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion ?? "0.1.0",
    sampleRate: config.samplingRate ?? 1.0,
    metricsIntervalMs: config.metricsIntervalMs ?? 10_000,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(config.customExporter !== undefined
      ? { customExporter: config.customExporter }
      : {}),
  };

  // A user-supplied customExporter takes precedence over the built-in exporter
  // selection. OpenTelemetryManager routes through `customExporter` when one is
  // present, so we short-circuit here and skip constructing a backend exporter.
  if (config.customExporter !== undefined) {
    return { ...base, exporter: "none" };
  }

  if (exporterType === "datadog") {
    return {
      ...base,
      exporter: "otlp",
      ...(endpoint !== undefined ? { endpoint } : {}),
      customExporter: new DatadogHttpTelemetryExporter(
        endpoint ?? (DEFAULT_EXPORTER_ENDPOINTS.datadog as string),
        config.apiKey,
        config.headers ?? {},
      ),
    };
  }

  return {
    ...base,
    exporter: exporterType as OpenTelemetryExporterType,
    ...(endpoint !== undefined ? { endpoint } : {}),
  };
}

// ─── Manager Singleton ──────────────────────────────────────────────────────

let activeManager: OpenTelemetryManager | null = null;
let activeData: TelemetryData | null = null;
const warnedMethods = new Set<string>();

function warnIfUninitialized(methodName: string): void {
  if (!activeManager && !warnedMethods.has(methodName)) {
    warnedMethods.add(methodName);
    console.warn(
      `[sorokit:telemetry] ${methodName}() was called before initTelemetry() was invoked. ` +
        `Telemetry is uninitialized and operations will silently no-op. ` +
        `Call initTelemetry({ serviceName: '...' }) to configure tracing and metrics.`,
    );
  }
}

/**
 * Initializes OpenTelemetry-compatible tracing and metrics for the SDK.
 *
 * Validates `config`, resolves the requested exporter (Jaeger, Datadog,
 * OTLP, or a local console/memory sink), and installs a process-wide
 * telemetry manager used by {@link traceSpan} and the named `trace*`
 * helpers. Safe to call more than once — each call replaces the previously
 * installed manager (the old one is left to be garbage collected; call
 * {@link shutdownTelemetry} first if you need its exporters flushed).
 *
 * @example
 * const result = initTelemetry({ serviceName: "my-app", exporter: "jaeger", samplingRate: 0.1 });
 * if (result.status === "ok") {
 *   console.log("Telemetry ready:", result.data.instanceId);
 * }
 */
export function initTelemetry(config: TelemetryConfig): SorokitResult<TelemetryData> {
  const validationError = validateTelemetryConfig(config);
  if (validationError) {
    return err(SorokitErrorCode.INVALID_CONFIG, validationError, config);
  }

  try {
    const otelConfig = resolveOpenTelemetryConfig(config);
    const manager = createOpenTelemetryManager(otelConfig);
    const resolvedExporter = config.exporter ?? "otlp";

    const data: TelemetryData = {
      serviceName: otelConfig.serviceName as string,
      serviceVersion: otelConfig.serviceVersion as string,
      exporter: resolvedExporter,
      samplingRate: otelConfig.sampleRate as number,
      ...(otelConfig.endpoint !== undefined ? { endpoint: otelConfig.endpoint } : {}),
      instanceId: generateTraceId(),
      initializedAt: Date.now(),
    };

    activeManager = manager;
    activeData = data;
    warnedMethods.clear();

    return ok(data);
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      `Failed to initialize telemetry: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/**
 * Returns the currently installed telemetry manager, or `null` if uninitialized.
 *
 * Emits a console warning if called before `initTelemetry()`. To prevent log spam,
 * the warning is logged at most once per session until telemetry is initialized or reset.
 */
export function getTelemetryManager(): OpenTelemetryManager | null {
  if (!activeManager) {
    warnIfUninitialized("getTelemetryManager");
    return null;
  }
  return activeManager;
}

/**
 * Returns the `TelemetryData` from the most recent successful `initTelemetry` call,
 * or `null` if uninitialized.
 *
 * Emits a console warning if called before `initTelemetry()`. To prevent log spam,
 * the warning is logged at most once per session until telemetry is initialized or reset.
 */
export function getTelemetryData(): TelemetryData | null {
  if (!activeData) {
    warnIfUninitialized("getTelemetryData");
    return null;
  }
  return activeData;
}

/** Whether telemetry has been initialized and is currently active. */
export function isTelemetryInitialized(): boolean {
  return activeManager !== null && activeManager.isEnabled();
}

/**
 * Validates that telemetry has been initialized and is currently active.
 *
 * Returns an ok `SorokitResult` if active, or an error `SorokitResult` with
 * `SorokitErrorCode.INVALID_CONFIG` if uninitialized.
 */
export function validateTelemetryInitialized(): SorokitResult<void> {
  if (!activeManager || !activeManager.isEnabled()) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Telemetry is uninitialized. Call initTelemetry({ serviceName: '...' }) before accessing telemetry.",
    );
  }
  return ok(undefined);
}

/**
 * Returns the active telemetry manager, or an error `SorokitResult` if uninitialized.
 *
 * Useful for callers that require strict initialization guarantees without silent no-ops.
 */
export function requireTelemetryManager(): SorokitResult<OpenTelemetryManager> {
  if (!activeManager) {
    warnIfUninitialized("requireTelemetryManager");
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Telemetry manager is uninitialized. Call initTelemetry({ serviceName: '...' }) before accessing the manager.",
    );
  }
  return ok(activeManager);
}

/**
 * Returns the active `TelemetryData`, or an error `SorokitResult` if uninitialized.
 *
 * Useful for callers that require strict initialization guarantees without silent no-ops.
 */
export function requireTelemetryData(): SorokitResult<TelemetryData> {
  if (!activeData) {
    warnIfUninitialized("requireTelemetryData");
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Telemetry data is uninitialized. Call initTelemetry({ serviceName: '...' }) before accessing telemetry data.",
    );
  }
  return ok(activeData);
}

/**
 * Shuts down the active telemetry manager (flushing/stopping its exporter)
 * and clears the installed singleton. Safe to call when telemetry was never
 * initialized.
 */
export async function shutdownTelemetry(): Promise<SorokitResult<void>> {
  if (!activeManager) {
    activeData = null;
    warnedMethods.clear();
    return ok(undefined);
  }
  try {
    await activeManager.shutdown();
    activeManager = null;
    activeData = null;
    warnedMethods.clear();
    return ok(undefined);
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      `Failed to shut down telemetry: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/**
 * Resets telemetry state synchronously without flushing the exporter.
 * Intended for tests; production code should prefer {@link shutdownTelemetry}.
 */
export function resetTelemetry(): void {
  activeManager = null;
  activeData = null;
  warnedMethods.clear();
}

// ─── Tracing Helpers ────────────────────────────────────────────────────────

/**
 * Runs `fn` inside a trace span named `name`. When telemetry has not been
 * initialized, `fn` is invoked directly with no span (zero overhead) — this
 * makes `traceSpan` safe for any SDK module to call unconditionally.
 *
 * Duration, success count, and error count metrics are recorded
 * automatically (see `OpenTelemetryManager.withSpan`).
 */
export async function traceSpan<T>(
  name: string,
  fn: (span?: TelemetrySpan) => Promise<T> | T,
  options?: StartSpanOptions,
): Promise<T> {
  if (!activeManager) {
    return fn();
  }
  return activeManager.withSpan(name, (span) => fn(span), options ?? {});
}

/** Traces a wallet connection attempt under the `wallet.connect` span name. */
export function traceWalletConnect<T>(
  fn: (span?: TelemetrySpan) => Promise<T> | T,
  attributes?: Record<string, unknown>,
): Promise<T> {
  return traceSpan("wallet.connect", fn, attributes ? { attributes } : {});
}

/** Traces a transaction submission under the `transaction.submit` span name. */
export function traceTransactionSubmit<T>(
  fn: (span?: TelemetrySpan) => Promise<T> | T,
  attributes?: Record<string, unknown>,
): Promise<T> {
  return traceSpan("transaction.submit", fn, attributes ? { attributes } : {});
}

/** Traces an account lookup under the `account.fetch` span name. */
export function traceAccountFetch<T>(
  fn: (span?: TelemetrySpan) => Promise<T> | T,
  attributes?: Record<string, unknown>,
): Promise<T> {
  return traceSpan("account.fetch", fn, attributes ? { attributes } : {});
}

/** Traces a Soroban contract invocation under the `contract.call` span name. */
export function traceContractCall<T>(
  fn: (span?: TelemetrySpan) => Promise<T> | T,
  attributes?: Record<string, unknown>,
): Promise<T> {
  return traceSpan("contract.call", fn, attributes ? { attributes } : {});
}

// ─── Metrics Helpers ────────────────────────────────────────────────────────

/**
 * Records an operation's duration as a histogram metric
 * (`<operation>.duration_ms`). No-op when telemetry is uninitialized.
 */
export function recordOperationDuration(
  operation: string,
  durationMs: number,
  attributes?: Record<string, unknown>,
): void {
  activeManager?.recordHistogram(`${operation}.duration_ms`, durationMs, attributes, "ms");
}

/**
 * Increments an operation's error counter (`<operation>.error_count`).
 * No-op when telemetry is uninitialized.
 */
export function recordOperationError(
  operation: string,
  attributes?: Record<string, unknown>,
): void {
  activeManager?.recordCounter(`${operation}.error_count`, 1, attributes);
}

/**
 * Records a cache hit or miss for `cacheName` as a counter metric
 * (`<cacheName>.cache_hit` / `<cacheName>.cache_miss`). No-op when
 * telemetry is uninitialized.
 */
export function recordCacheHit(
  cacheName: string,
  hit: boolean,
  attributes?: Record<string, unknown>,
): void {
  activeManager?.recordCounter(
    hit ? `${cacheName}.cache_hit` : `${cacheName}.cache_miss`,
    1,
    attributes,
  );
}

/**
 * Returns aggregated metric summaries (duration percentiles, counts) from the active manager.
 * Emits a console warning if called before `initTelemetry()` (at most once per session).
 */
export function getTelemetryMetricsSummary(metricName?: string): Record<string, OtelMetricSummary> {
  if (!activeManager) {
    warnIfUninitialized("getTelemetryMetricsSummary");
    return {};
  }
  return activeManager.getMetricsSummary(metricName);
}

/**
 * Returns exported spans held by the in-memory exporter, if that's the active exporter.
 * Emits a console warning if called before `initTelemetry()` (at most once per session).
 */
export function getTelemetrySpans(): SpanData[] {
  if (!activeManager) {
    warnIfUninitialized("getTelemetrySpans");
    return [];
  }
  return activeManager.getExportedSpans();
}

// ─── OpenTelemetry JS API bridge (#155) ──────────────────────────────────────
//
// The adapter below forwards the SDK's vendor-agnostic spans and metrics to
// the *official* @opentelemetry/api TracerProvider / MeterProvider a host
// application has configured, so operators can ship Sorokit telemetry to any
// standard OTel-compatible backend (Jaeger, Tempo, Prometheus, Datadog Agent,
// …) without a custom bridge.
//
// @opentelemetry/api is an OPTIONAL peer dependency. It is loaded with a
// *runtime* dynamic import (the module specifier is a variable, not a string
// literal), so TypeScript and bundlers never resolve it statically. Consumers
// who never call `createOtelApiExporter` therefore pay no bundle cost and the
// package is tree-shaken when unused. The local interfaces below mirror only
// the small slice of the @opentelemetry/api surface this adapter drives, so
// the file compiles whether or not the package is installed.

/** Numeric span kinds as defined by the OpenTelemetry trace data model. */
const OTEL_SPAN_KIND_INTERNAL = 0;
const OTEL_SPAN_KIND_SERVER = 1;
const OTEL_SPAN_KIND_CLIENT = 2;
const OTEL_SPAN_KIND_PRODUCER = 3;
const OTEL_SPAN_KIND_CONSUMER = 4;

/** Numeric span status codes as defined by the OpenTelemetry trace data model. */
const OTEL_SPAN_STATUS_UNSET = 0;
const OTEL_SPAN_STATUS_OK = 1;
const OTEL_SPAN_STATUS_ERROR = 2;

function mapSpanKind(kind: SpanKind): number {
  switch (kind) {
    case "server":
      return OTEL_SPAN_KIND_SERVER;
    case "client":
      return OTEL_SPAN_KIND_CLIENT;
    case "producer":
      return OTEL_SPAN_KIND_PRODUCER;
    case "consumer":
      return OTEL_SPAN_KIND_CONSUMER;
    case "internal":
    default:
      return OTEL_SPAN_KIND_INTERNAL;
  }
}

function mapSpanStatus(code: SpanStatusCode): number {
  switch (code) {
    case "ok":
      return OTEL_SPAN_STATUS_OK;
    case "error":
      return OTEL_SPAN_STATUS_ERROR;
    case "unset":
    default:
      return OTEL_SPAN_STATUS_UNSET;
  }
}

/**
 * Minimal structural shape of an official @opentelemetry/api `Span` this
 * adapter drives. Only the methods we call are declared.
 */
interface OtelApiSpan {
  setAttribute(key: string, value: unknown): OtelApiSpan;
  addEvent(name: string, attributes?: Record<string, unknown> | undefined): OtelApiSpan;
  setStatus(status: { code: number; message?: string | undefined }): OtelApiSpan;
  end(endTime?: number | undefined): void;
}

/** Minimal structural shape of an official @opentelemetry/api `Tracer`. */
interface OtelApiTracer {
  startSpan(
    name: string,
    options?:
      | {
          kind?: number | undefined;
          attributes?: Record<string, unknown> | undefined;
          startTime?: number | undefined;
        }
      | undefined,
  ): OtelApiSpan;
}

/** Minimal structural shape of an official @opentelemetry/api `Counter`. */
interface OtelApiCounter {
  add(value: number, attributes?: Record<string, unknown> | undefined): void;
}

/** Minimal structural shape of an official @opentelemetry/api `Histogram`. */
interface OtelApiHistogram {
  record(value: number, attributes?: Record<string, unknown> | undefined): void;
}

/** Minimal structural shape of an official @opentelemetry/api `Meter`. */
interface OtelApiMeter {
  createCounter(
    name: string,
    options?:
      | { description?: string | undefined; unit?: string | undefined }
      | undefined,
  ): OtelApiCounter;
  createHistogram(
    name: string,
    options?:
      | { description?: string | undefined; unit?: string | undefined }
      | undefined,
  ): OtelApiHistogram;
}

/** The slice of the @opentelemetry/api module this adapter consumes. */
interface OtelApiModule {
  trace: {
    getTracer(name: string, version?: string | undefined): OtelApiTracer;
  };
  metrics: {
    getMeter(name: string, version?: string | undefined): OtelApiMeter;
  };
}

/** Options shared by {@link createOtelApiExporter} and
 * {@link createOtelApiExporterFromProviders}. */
export interface OtelApiExporterOptions {
  /** Logical service name; used as the tracer/meter name. */
  serviceName: string;
  /** Service version, forwarded to `getTracer`/`getMeter`. */
  serviceVersion?: string | undefined;
}

/**
 * Bridges the SDK's internal spans and metrics to an official
 * @opentelemetry/api `TracerProvider` and `MeterProvider`.
 *
 * Construct it through {@link createOtelApiExporter} (which dynamically loads
 * `@opentelemetry/api`), or — when you already hold tracer/meter instances —
 * through {@link createOtelApiExporterFromProviders}. Then pass the instance
 * to `initTelemetry` via the `customExporter` config field.
 *
 * SDK spans are replayed as real OTel spans (name, kind, attributes, events,
 * status, end time). SDK counters map to OTel counters and SDK histograms map
 * to OTel histograms. Gauges have no synchronous equivalent in the stable
 * @opentelemetry/api metrics surface and are intentionally not forwarded —
 * the acceptance criteria scope this adapter to counters and histograms.
 */
export class OtelApiTelemetryExporter implements TelemetryExporter {
  private readonly tracer: OtelApiTracer;
  private readonly meter: OtelApiMeter;
  private readonly serviceName: string | undefined;
  private readonly counters = new Map<string, OtelApiCounter>();
  private readonly histograms = new Map<string, OtelApiHistogram>();

  constructor(tracer: OtelApiTracer, meter: OtelApiMeter, serviceName?: string) {
    this.tracer = tracer;
    this.meter = meter;
    this.serviceName = serviceName;
  }

  /** The service name this exporter reports as, if any. */
  public getServiceName(): string | undefined {
    return this.serviceName;
  }

  public exportSpans(spans: SpanData[]): void {
    for (const span of spans) {
      const otelSpan = this.tracer.startSpan(span.name, {
        kind: mapSpanKind(span.kind),
        attributes: span.attributes,
        ...(span.startTime !== undefined ? { startTime: span.startTime } : {}),
      });
      for (const [key, value] of Object.entries(span.attributes)) {
        otelSpan.setAttribute(key, value);
      }
      for (const event of span.events) {
        otelSpan.addEvent(event.name, event.attributes);
      }
      otelSpan.setStatus({
        code: mapSpanStatus(span.status.code),
        ...(span.status.description !== undefined
          ? { message: span.status.description }
          : {}),
      });
      otelSpan.end(span.endTime);
    }
  }

  public exportMetrics(metrics: OtelMetricRecord[]): void {
    for (const metric of metrics) {
      if (metric.type === "counter") {
        const counter = this.getOrCreateCounter(metric);
        counter.add(metric.value, metric.attributes);
      } else if (metric.type === "histogram") {
        const histogram = this.getOrCreateHistogram(metric);
        histogram.record(metric.value, metric.attributes);
      }
      // Gauges are intentionally not bridged: the stable @opentelemetry/api
      // metrics surface exposes only *observable* gauges (callback-driven),
      // which do not fit a push-based exporter. Counters and histograms — the
      // SDK's primary metric instruments — are fully mapped above.
    }
  }

  private metricOptions(
    metric: OtelMetricRecord,
  ): { description?: string | undefined; unit?: string | undefined } {
    return {
      ...(metric.description !== undefined ? { description: metric.description } : {}),
      ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
    };
  }

  private getOrCreateCounter(metric: OtelMetricRecord): OtelApiCounter {
    const existing = this.counters.get(metric.name);
    if (existing) return existing;
    const counter = this.meter.createCounter(metric.name, this.metricOptions(metric));
    this.counters.set(metric.name, counter);
    return counter;
  }

  private getOrCreateHistogram(metric: OtelMetricRecord): OtelApiHistogram {
    const existing = this.histograms.get(metric.name);
    if (existing) return existing;
    const histogram = this.meter.createHistogram(metric.name, this.metricOptions(metric));
    this.histograms.set(metric.name, histogram);
    return histogram;
  }
}

/**
 * Builds an {@link OtelApiTelemetryExporter} from `Tracer` and `Meter`
 * instances you already hold. Use this when your application has already
 * configured a global `TracerProvider` / `MeterProvider` (e.g. via
 * `@opentelemetry/sdk-node`) and you want to forward SDK telemetry into it
 * without an extra dynamic import of `@opentelemetry/api`.
 */
export function createOtelApiExporterFromProviders(
  tracer: OtelApiTracer,
  meter: OtelApiMeter,
  options?: OtelApiExporterOptions,
): OtelApiTelemetryExporter {
  return new OtelApiTelemetryExporter(tracer, meter, options?.serviceName);
}

/**
 * Dynamically loads the official `@opentelemetry/api` package and builds an
 * {@link OtelApiTelemetryExporter} that forwards the SDK's spans and metrics
 * to the host-configured OTel `TracerProvider` / `MeterProvider`.
 *
 * `@opentelemetry/api` is an OPTIONAL peer dependency. It is imported
 * dynamically, so this call — and the package itself — is tree-shaken from
 * bundles that never invoke it. If the package is not installed (or fails to
 * load), this returns an `error` result instead of throwing, so callers can
 * fall back to another exporter or leave telemetry disabled.
 *
 * @example
 * const exporter = await createOtelApiExporter({ serviceName: "my-app" });
 * if (exporter.status === "ok") {
 *   initTelemetry({ serviceName: "my-app", customExporter: exporter.data });
 * }
 */
export async function createOtelApiExporter(
  options: OtelApiExporterOptions,
): Promise<SorokitResult<OtelApiTelemetryExporter>> {
  let api: OtelApiModule;
  try {
    api = await __otelApiLoader.load();
  } catch (cause) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Failed to load @opentelemetry/api. Install it (npm install @opentelemetry/api) and register a TracerProvider/MeterProvider before enabling the OTel exporter, or pass a pre-built exporter via `customExporter`.",
      cause,
    );
  }
  return buildOtelApiExporter(api, options);
}

function buildOtelApiExporter(
  api: OtelApiModule,
  options: OtelApiExporterOptions,
): SorokitResult<OtelApiTelemetryExporter> {
  if (!api || typeof api !== "object") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "@opentelemetry/api loaded an unexpected value; ensure @opentelemetry/api >= 1.0 is installed.",
    );
  }
  const traceApi = api.trace;
  const metricsApi = api.metrics;
  if (!traceApi || typeof traceApi.getTracer !== "function") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "@opentelemetry/api did not expose a trace API. Ensure @opentelemetry/api >= 1.0 is installed and a TracerProvider is registered.",
    );
  }
  if (!metricsApi || typeof metricsApi.getMeter !== "function") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "@opentelemetry/api did not expose a metrics API. Ensure @opentelemetry/api >= 1.0 is installed and a MeterProvider is registered.",
    );
  }
  const tracer = traceApi.getTracer(options.serviceName, options.serviceVersion);
  const meter = metricsApi.getMeter(options.serviceName, options.serviceVersion);
  return ok(new OtelApiTelemetryExporter(tracer, meter, options.serviceName));
}

/**
 * Loads the `@opentelemetry/api` module on demand. The specifier is a runtime
 * variable (not a string literal) so TypeScript and bundlers never resolve it
 * statically — this is what keeps `@opentelemetry/api` an optional,
 * tree-shakeable peer dependency. Tests override `load` to inject a fake API.
 * @internal
 */
export const __otelApiLoader: { load(): Promise<OtelApiModule> } = {
  async load(): Promise<OtelApiModule> {
    // A non-literal specifier makes `import()` resolve at runtime only and
    // return `Promise<any>`, which is why no type declaration for
    // "@opentelemetry/api" is required for this file to compile.
    const specifier = "@opentelemetry/api";
    const mod = (await import(/* @vite-ignore */ specifier)) as unknown as OtelApiModule;
    return mod;
  },
};

