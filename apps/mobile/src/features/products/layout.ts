import { components } from '../../design';

// The floating tab bar is absolutely positioned (design/FloatingTabBar): a 62 pt pill whose bottom edge sits
// max(bottom inset + 8, 10) above the screen edge. A footer on a tab screen has to clear all of it.
const TAB_BAR_PILL_HEIGHT = 62;
const TAB_BAR_GAP = 8;

// Extra bottom margin for a sticky footer inside a Screen, which already pads the bottom safe area.
export function tabBarClearance(bottomInset: number): number {
  const { bottomOffset, minBottomInset } = components.floatingTabBar;
  return Math.max(bottomInset + bottomOffset, minBottomInset) + TAB_BAR_PILL_HEIGHT + TAB_BAR_GAP - bottomInset;
}
