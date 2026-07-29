import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { ExperimentalSessionViewModel } from "../src/experimental/client-server/client-controller.ts";

function snapshot(revision: number, text = "saved"): SessionSnapshot {
	return {
		id: "session-1",
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: revision + 1,
		phase: "turn",
		model: { provider: "faux", id: "faux-1" },
		thinkingLevel: "off",
		attached: true,
		locked: true,
		revision,
		transcript: [
			{
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "text", text }],
				status: "streaming",
				model: { provider: "faux", id: "faux-1" },
				timestamp: 1,
			},
		],
		queuedSteer: [],
		queuedSteerCount: 0,
	};
}

describe("experimental client view model", () => {
	test("projects progress without mutating the authoritative snapshot", () => {
		const model = new ExperimentalSessionViewModel();
		model.applySnapshot(snapshot(1));
		model.applyProgress({
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: " response",
		});

		expect(model.snapshot?.transcript[0]).toMatchObject({ content: [{ type: "text", text: "saved" }] });
		expect(model.view()?.transcript[0]).toMatchObject({ content: [{ type: "text", text: "saved response" }] });
	});

	test("appends transient tool progress and replaces it by id", () => {
		const model = new ExperimentalSessionViewModel();
		model.applySnapshot(snapshot(1));
		model.applyProgress({
			type: "item_started",
			item: {
				id: "tool-call-1",
				role: "tool",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "printf hi" },
				content: [],
				status: "running",
				isError: false,
				timestamp: 2,
			},
		});
		model.applyProgress({
			type: "item_updated",
			item: {
				id: "tool-call-1",
				role: "tool",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "printf hi" },
				content: [{ type: "text", text: "hi" }],
				status: "running",
				isError: false,
				timestamp: 2,
			},
		});

		expect(model.view()?.transcript).toHaveLength(2);
		expect(model.view()?.transcript[1]).toMatchObject({
			role: "tool",
			status: "running",
			content: [{ type: "text", text: "hi" }],
		});
	});

	test("resets revision history when the same session runtime is reacquired", () => {
		const model = new ExperimentalSessionViewModel();
		model.applySnapshot(snapshot(50, "old runtime"));
		model.reset(snapshot(0, "new runtime"));

		expect(model.snapshot?.revision).toBe(0);
		expect(model.view()?.transcript[0]).toMatchObject({ content: [{ text: "new runtime" }] });
	});

	test("accepts a lower revision when switching to a different session", () => {
		const model = new ExperimentalSessionViewModel();
		model.applySnapshot(snapshot(50, "old session"));
		model.applySnapshot({ ...snapshot(0, "new session"), id: "session-2" });

		expect(model.snapshot?.id).toBe("session-2");
		expect(model.view()?.transcript[0]).toMatchObject({ content: [{ text: "new session" }] });
	});

	test("renders accepted steering messages from authoritative queued state", () => {
		const model = new ExperimentalSessionViewModel();
		model.applySnapshot({
			...snapshot(2),
			queuedSteerCount: 1,
			queuedSteer: [
				{
					id: "user-steer",
					role: "user",
					content: [{ type: "text", text: "adjust the approach" }],
					timestamp: 2,
				},
			],
		});

		expect(model.view()?.transcript.at(-1)).toMatchObject({
			role: "user",
			content: [{ text: "adjust the approach" }],
		});
	});

	test("a newer snapshot is authoritative and stale snapshots are ignored", () => {
		const model = new ExperimentalSessionViewModel();
		model.applySnapshot(snapshot(3, "new"));
		model.applyProgress({
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: " transient",
		});
		model.applySnapshot(snapshot(4, "authoritative"));
		model.applySnapshot(snapshot(2, "stale"));

		expect(model.snapshot?.revision).toBe(4);
		expect(model.view()?.transcript[0]).toMatchObject({
			content: [{ type: "text", text: "authoritative" }],
		});
	});
});
