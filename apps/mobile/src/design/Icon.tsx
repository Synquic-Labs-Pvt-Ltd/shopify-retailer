import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { colors, components } from './theme';

type AnyIconName = ComponentProps<typeof Ionicons>['name'];

// The spec uses Ionicons outline variants only.
export type IconName = Extract<AnyIconName, `${string}-outline`>;

export interface IconProps {
  name: IconName;
  // 18 for chevrons, 20 to 22 for rows and nav, 26 to 30 for large actions.
  size?: number;
  color?: string;
}

export function Icon({ name, size = components.icons.rowMax, color = colors.ink }: IconProps) {
  return <Ionicons name={name} size={size} color={color} />;
}
