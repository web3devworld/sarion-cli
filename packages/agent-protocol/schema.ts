import Ajv from 'ajv';
import schemas from './schema.json' with { type: 'json' };
import { Failure } from './validation.ts';
const ajv = new Ajv.default({ allErrors: true, strict: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export function validate<T>(name: keyof typeof schemas, value: unknown): T {
  let fn = validators.get(name);
  if (!fn) {
    fn = ajv.compile(schemas[name]);
    validators.set(name, fn);
  }
  if (!fn(value)) throw new Failure('INVALID_REQUEST', 'Invalid ' + name + ': ' + ajv.errorsText(fn.errors), 2);
  return value as T;
}

export function validateInput(schema: object, value: unknown): void {
  const check = ajv.compile(schema);
  if (!check(value)) throw new Failure('INVALID_REQUEST', 'Invalid tool arguments: ' + ajv.errorsText(check.errors), 2);
}
