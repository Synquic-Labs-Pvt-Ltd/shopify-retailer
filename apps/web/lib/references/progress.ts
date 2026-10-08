// Progress is written to the persisted draft, so it is reported in steps (4% by default) instead of per event.
export const PROGRESS_STEP = 0.04;

// Guards against float noise: 0.09 - 0.05 is 0.03999999999999999, which is still a step of 4%.
const EPSILON = 1e-9;

export function createProgressStepper(emit: (fraction: number) => void, step: number = PROGRESS_STEP) {
  let last = 0;
  return (fraction: number): void => {
    if (fraction >= 1 ? last < 1 : fraction - last >= step - EPSILON) {
      last = fraction;
      emit(fraction);
    }
  };
}
