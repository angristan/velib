import { assert, it } from "@effect/vitest"

import { ApiRequestError } from "./api"
import { retryServerQuery } from "./query-client"

it("retries only bounded recoverable server queries", () => {
  assert.isFalse(retryServerQuery(0, new ApiRequestError(401, "Unauthorized")))
  assert.isFalse(retryServerQuery(0, new ApiRequestError(404, "Missing")))
  assert.isTrue(retryServerQuery(0, new ApiRequestError(503, "Unavailable")))
  assert.isTrue(retryServerQuery(1, new TypeError("Network failure")))
  assert.isFalse(retryServerQuery(2, new TypeError("Network failure")))
  assert.isFalse(retryServerQuery(0, new Error("Invalid payload")))
})
