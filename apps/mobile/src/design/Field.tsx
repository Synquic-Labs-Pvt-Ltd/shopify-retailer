import { useState } from 'react';
import { StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { AppText, resolveTextStyle } from './AppText';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { borders, colors, components, pressScale, spacing, typography } from './theme';

export interface FieldProps
  extends Omit<TextInputProps, 'style' | 'editable' | 'placeholderTextColor' | 'selectionColor'> {
  // Uppercase section label above the box. Omit for label-less fields such as search.
  label?: string;
  // Adds an asterisk to the label.
  required?: boolean;
  // Hairline border instead of a transparent one.
  boxed?: boolean;
  // Red border and red meta text below the box.
  error?: string | null;
  // Canvas fill with a lock icon; the value cannot be edited.
  readOnly?: boolean;
  // Meta text inside the box, after the input (for example ".myshopify.com").
  suffix?: string;
  // Leading icon inside the box (search fields).
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}

// secureTextEntry adds the password eye toggle.
export function Field({
  label,
  required = false,
  boxed = false,
  error,
  readOnly = false,
  suffix,
  icon,
  secureTextEntry,
  style,
  onFocus,
  onBlur,
  ...inputProps
}: FieldProps) {
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const hasError = error !== undefined && error !== null && error !== '';

  let borderColor = 'transparent';
  if (boxed) borderColor = borders.hairlineColor;
  if (focused && !readOnly) borderColor = colors.ink;
  if (hasError) borderColor = colors.danger;

  return (
    <View style={[styles.root, style]}>
      {label !== undefined && (
        <AppText variant="sectionLabel" color={colors.meta}>
          {label}
          {required ? ' *' : ''}
        </AppText>
      )}
      <View
        style={[
          styles.box,
          { borderColor, backgroundColor: readOnly ? colors.canvas : colors.surface },
        ]}
      >
        {icon !== undefined && <Icon name={icon} size={components.icons.rowMin} color={colors.meta} />}
        <TextInput
          {...inputProps}
          editable={!readOnly}
          secureTextEntry={secureTextEntry === true && !revealed}
          placeholderTextColor={colors.inkMuted}
          selectionColor={colors.ink}
          accessibilityLabel={inputProps.accessibilityLabel ?? label}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[styles.input, inputText]}
        />
        {suffix !== undefined && (
          <AppText variant="meta" color={colors.meta}>
            {suffix}
          </AppText>
        )}
        {secureTextEntry === true && !readOnly && (
          <PressableScale
            scale={pressScale.iconButton}
            haptic="selection"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            onPress={() => setRevealed((value) => !value)}
          >
            <Icon name={revealed ? 'eye-off-outline' : 'eye-outline'} size={components.icons.rowMax} color={colors.meta} />
          </PressableScale>
        )}
        {readOnly && <Icon name="lock-closed-outline" size={components.field.lockSize} color={colors.meta} />}
      </View>
      {hasError && (
        <AppText variant="meta" color={colors.danger} accessibilityLiveRegion="polite">
          {error}
        </AppText>
      )}
    </View>
  );
}

// A fixed line height inside TextInput misaligns the text on iOS; the box height comes from minHeight.
const { lineHeight: _lineHeight, ...inputTextStyle } = resolveTextStyle(typography.bodyMedium);
const inputText = { ...inputTextStyle, color: colors.ink };

const styles = StyleSheet.create({
  root: { gap: spacing.sm },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: components.field.minHeight,
    paddingHorizontal: components.field.paddingX,
    borderRadius: components.field.radius,
    borderWidth: components.field.borderWidth,
  },
  input: { flex: 1, paddingVertical: 0 },
});
