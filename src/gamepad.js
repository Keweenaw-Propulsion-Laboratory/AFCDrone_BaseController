// Maps a W3C "standard"-layout Gamepad to drone command values. Kept free of
// DOM access so the mapping can be unit-tested under Node.
//
//   Left stick X/Y   -> gimbal X/Y (absolute, full deflection = field limit)
//   Right trigger    -> throttle for both motors
//   Right stick X    -> motor differential (positive = more motor 0)
//   South button (A) -> safe mode (handled by the caller on the rising edge)

export const GAMEPAD_BUTTONS = Object.freeze({
  SOUTH: 0,
  RIGHT_TRIGGER: 7,
});

export const GAMEPAD_AXES = Object.freeze({
  LEFT_X: 0,
  LEFT_Y: 1,
  RIGHT_X: 2,
});

export const STICK_DEADZONE = 0.08;
export const TRIGGER_DEADZONE = 0.03;
// Arming is refused while the throttle is above this, so control can't be
// taken with the trigger already held down.
export const ARM_THROTTLE_LIMIT = 0.05;

// Rescales so output starts at 0 at the deadzone edge instead of jumping.
export function applyDeadzone(value, deadzone) {
  const magnitude = Math.abs(value);
  if (!Number.isFinite(value) || magnitude <= deadzone) return 0;
  return Math.sign(value) * Math.min(1, (magnitude - deadzone) / (1 - deadzone));
}

export function readThrottle(gamepad) {
  const trigger = gamepad.buttons[GAMEPAD_BUTTONS.RIGHT_TRIGGER];
  return applyDeadzone(trigger?.value ?? 0, TRIGGER_DEADZONE);
}

export function isSouthPressed(gamepad) {
  return Boolean(gamepad.buttons[GAMEPAD_BUTTONS.SOUTH]?.pressed);
}

// The differential scales with throttle, so zero trigger always means both
// motors at zero regardless of where the right stick sits.
export function gamepadToCommand(gamepad, { gimbalLimit = 20, motorMax = 255 } = {}) {
  const axis = (index) => gamepad.axes[index] ?? 0;
  const leftX = applyDeadzone(axis(GAMEPAD_AXES.LEFT_X), STICK_DEADZONE);
  // Standard mapping reports stick-up as -1; flip so up is positive gimbal Y.
  const leftY = -applyDeadzone(axis(GAMEPAD_AXES.LEFT_Y), STICK_DEADZONE);
  const differential = applyDeadzone(axis(GAMEPAD_AXES.RIGHT_X), STICK_DEADZONE);
  const throttle = readThrottle(gamepad);

  const clampMotor = (value) => Math.round(Math.max(0, Math.min(1, value)) * motorMax);
  const roundTenth = (value) => Math.round(value * 10) / 10 || 0;

  return {
    gimbalX: roundTenth(leftX * gimbalLimit),
    gimbalY: roundTenth(leftY * gimbalLimit),
    motor0Speed: clampMotor(throttle * (1 + differential)),
    motor1Speed: clampMotor(throttle * (1 - differential)),
  };
}
