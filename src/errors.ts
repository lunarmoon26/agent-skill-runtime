/** Base error with a stable machine-readable runtime code. */
export class SkillRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "SkillRuntimeError"
  }
}

/** Manifest or tool input failed JSON validation. */
export class SkillValidationError extends SkillRuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "SKILL_VALIDATION_ERROR", options)
    this.name = "SkillValidationError"
  }
}

/** A requested engine or capability is unavailable or not approved. */
export class SkillPolicyError extends SkillRuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "SKILL_POLICY_ERROR", options)
    this.name = "SkillPolicyError"
  }
}

/** A child process failed the JSON-in/JSON-out execution contract. */
export class SkillExecutionError extends SkillRuntimeError {
  constructor(message: string, code = "SKILL_EXECUTION_ERROR", options?: ErrorOptions) {
    super(message, code, options)
    this.name = "SkillExecutionError"
  }
}
