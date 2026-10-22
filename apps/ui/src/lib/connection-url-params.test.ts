import { describe, expect, test } from "bun:test";
import { CREDENTIAL_URL_PARAMS, withoutConnectionParams } from "./connection-url-params";

describe("withoutConnectionParams", () => {
  test("drops the connection and identity params and keeps the rest in order", () => {
    expect(
      withoutConnectionParams("?apiUrl=http%3A%2F%2Fx&tabs=a%2Cnew&apiKey=123123&view=inbox"),
    ).toBe("?tabs=a%2Cnew&view=inbox");
    expect(withoutConnectionParams("?email=a%40b.c&name=Alex")).toBe("");
  });

  test("the credential list keeps a page's own name param", () => {
    expect(withoutConnectionParams("?new=1&name=github&apiKey=123123", CREDENTIAL_URL_PARAMS)).toBe(
      "?new=1&name=github",
    );
    expect(withoutConnectionParams("?new=1&name=github", CREDENTIAL_URL_PARAMS)).toBeNull();
  });

  test("returns null when there is nothing to drop", () => {
    expect(withoutConnectionParams("")).toBeNull();
    expect(withoutConnectionParams("?tabs=a&legacy=1")).toBeNull();
  });
});
