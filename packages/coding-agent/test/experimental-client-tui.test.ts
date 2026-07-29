import { describe, expect, test } from "vitest";
import { DoubleClearAction } from "../src/experimental/client-server/tui.ts";

describe("experimental client TUI", () => {
	test("exits only when app.clear is triggered twice within 500 ms", () => {
		const action = new DoubleClearAction();

		expect(action.trigger(1_000)).toBe("clear");
		expect(action.trigger(1_499)).toBe("exit");
	});

	test("starts a new double-clear window after the timeout", () => {
		const action = new DoubleClearAction();

		expect(action.trigger(1_000)).toBe("clear");
		expect(action.trigger(1_500)).toBe("clear");
		expect(action.trigger(1_999)).toBe("exit");
	});
});
