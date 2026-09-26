declare module "ioredis-mock" {
  import type { Redis } from "ioredis";
  export default class RedisMock {
    constructor(options?: object);
    disconnect(): void;
  }
  // Compatible enough for tests
  export { RedisMock as Redis };
}
