type SkillOperationDiagnostics = Record<string, unknown>;

type SkillOperationErrorContext = {
  action: string;
  fallback: string;
  step?: string | null;
  skillKey?: string | null;
  agentId?: string | null;
  diagnostics?: SkillOperationDiagnostics;
};

const stringifyDiagnosticValue = (value: unknown): string => {
  if (value === undefined || value === null) {
    return "(missing)";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || "(empty)";
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const appendRecordField = (
  fields: string[],
  label: string,
  value: unknown,
) => {
  if (value === undefined) {
    return;
  }
  fields.push(`${label}=${stringifyDiagnosticValue(value)}`);
};

const collectGatewayErrorDetails = (err: unknown): string[] => {
  if (!err || typeof err !== "object") {
    return [];
  }
  const record = err as Record<string, unknown>;
  const fields: string[] = [];
  appendRecordField(fields, "gatewayCode", record.code);
  appendRecordField(fields, "retryable", record.retryable);
  appendRecordField(fields, "retryAfterMs", record.retryAfterMs);
  appendRecordField(fields, "gatewayDetails", record.details);
  return fields;
};

export const formatSkillOperationError = (
  err: unknown,
  context: SkillOperationErrorContext,
): string => {
  const baseMessage =
    err instanceof Error && err.message.trim()
      ? err.message.trim()
      : context.fallback;
  const step = context.step?.trim();
  const headline = step
    ? `${context.action} while ${step}`
    : context.action;
  const detailFields: string[] = [];

  appendRecordField(detailFields, "skillKey", context.skillKey);
  appendRecordField(detailFields, "agentId", context.agentId);
  for (const [key, value] of Object.entries(context.diagnostics ?? {})) {
    detailFields.push(`${key}=${stringifyDiagnosticValue(value)}`);
  }
  detailFields.push(...collectGatewayErrorDetails(err));

  if (detailFields.length === 0) {
    return `${headline}: ${baseMessage}`;
  }
  return `${headline}: ${baseMessage}\nDetails: ${detailFields.join(", ")}`;
};
