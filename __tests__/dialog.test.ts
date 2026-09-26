import { Alert, Platform, type AlertButton, type AlertOptions } from "react-native";
import { confirm, isWeb, notify } from "../src/ui/dialog";

// ---------------------------------------------------------------------------
// The bug this suite pins down: react-native-web's Alert.alert() is an empty
// function, so in the web export every dialog in the app did nothing at all —
// including the "Delete all my data" confirmation, whose destructive callback
// could therefore never run. `Platform.OS` and the browser host are swapped
// per test and restored afterwards.
// ---------------------------------------------------------------------------

const originalOS = Platform.OS;
const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
const originalWindow = (globalThis as { window?: unknown }).window;

function setPlatform(os: string): void {
  Object.defineProperty(Platform, "OS", { value: os, configurable: true, writable: true });
}

function setWebHost(host: unknown): void {
  Object.defineProperty(globalThis, "window", { value: host, configurable: true, writable: true });
}

function restoreWindow(): void {
  if (hadWindow) setWebHost(originalWindow);
  else delete (globalThis as { window?: unknown }).window;
}

afterEach(() => {
  setPlatform(originalOS);
  restoreWindow();
  jest.restoreAllMocks();
});

describe("web dialogs", () => {
  test("isWeb() follows Platform.OS", () => {
    setPlatform("web");
    expect(isWeb()).toBe(true);
    setPlatform("android");
    expect(isWeb()).toBe(false);
  });

  test("notify() reaches window.alert instead of the react-native-web no-op", () => {
    setPlatform("web");
    const alert = jest.fn();
    setWebHost({ alert });
    notify("Nothing to add", "This capture produced no usable skin measurement.");
    expect(alert).toHaveBeenCalledWith(
      "Nothing to add\n\nThis capture produced no usable skin measurement."
    );
  });

  test("confirm() resolves from window.confirm both ways", async () => {
    setPlatform("web");
    setWebHost({ confirm: jest.fn(() => true) });
    await expect(
      confirm("Delete all stored data?", "gone", { confirmText: "Delete", destructive: true })
    ).resolves.toBe(true);
    setWebHost({ confirm: jest.fn(() => false) });
    await expect(confirm("Delete all stored data?", "gone")).resolves.toBe(false);
  });

  test("confirm() refuses rather than assuming when the host cannot ask", async () => {
    setPlatform("web");
    setWebHost({});
    await expect(confirm("Delete?", "gone")).resolves.toBe(false);
    setWebHost(undefined);
    await expect(confirm("Delete?", "gone")).resolves.toBe(false);
  });

  test("notify() never throws when the host has no alert", () => {
    setPlatform("web");
    setWebHost({});
    expect(() => notify("Title", "Body")).not.toThrow();
  });
});

describe("native dialogs", () => {
  test("notify() uses the native Alert and never the browser host", () => {
    setPlatform("android");
    const nativeAlert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const webAlert = jest.fn();
    setWebHost({ alert: webAlert });
    notify("Title", "Body");
    expect(nativeAlert).toHaveBeenCalledWith("Title", "Body");
    expect(webAlert).not.toHaveBeenCalled();
  });

  test("confirm() resolves true from the confirm button and false on cancel/dismiss", async () => {
    setPlatform("android");
    let options: AlertOptions | undefined;
    jest.spyOn(Alert, "alert").mockImplementation(
      (_title: string, _message?: string, buttons?: AlertButton[], opts?: AlertOptions) => {
        options = opts;
        (buttons ?? []).find((b) => b.text === "Delete")?.onPress?.();
      }
    );
    await expect(
      confirm("Delete?", "gone", { confirmText: "Delete", destructive: true })
    ).resolves.toBe(true);

    jest.restoreAllMocks();
    jest.spyOn(Alert, "alert").mockImplementation(
      (_title: string, _message?: string, buttons?: AlertButton[]) => {
        (buttons ?? []).find((b) => b.text === "Cancel")?.onPress?.();
      }
    );
    await expect(confirm("Delete?", "gone")).resolves.toBe(false);

    jest.restoreAllMocks();
    jest.spyOn(Alert, "alert").mockImplementation(
      (_title: string, _message?: string, _buttons?: AlertButton[], opts?: AlertOptions) => {
        options = opts;
        options?.onDismiss?.();
      }
    );
    await expect(confirm("Delete?", "gone")).resolves.toBe(false);
  });
});
