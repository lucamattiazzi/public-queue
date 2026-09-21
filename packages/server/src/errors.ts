export class Fault extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
