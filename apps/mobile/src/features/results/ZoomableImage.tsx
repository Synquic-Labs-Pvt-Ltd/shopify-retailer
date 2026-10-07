import { Image as ExpoImage } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { components } from '../../design';

// SPEC 16.2 MediaViewer: double tap zooms to 2.5x, pinch goes up to 4x.
export const DOUBLE_TAP_SCALE = 2.5;
export const MAX_SCALE = 4;
const ZOOMED = 1.01;

function clamp(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

// How far the image may travel from the center so that its edge never leaves the screen edge.
function travel(size: number, scale: number): number {
  'worklet';
  return (size * (scale - 1)) / 2;
}

export interface ZoomableImageProps {
  uri: string;
  // Shown while the full image loads.
  previewUri: string | null;
  width: number;
  height: number;
}

// Pinch, drag (only while zoomed in, so the pager can still swipe) and double tap. The shared values and the
// gestures run on the UI thread.
export function ZoomableImage({ uri, previewUri, width, height }: ZoomableImageProps) {
  const scale = useSharedValue(1);
  const startScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onStart(() => {
      'worklet';
      startScale.value = scale.value;
    })
    .onUpdate((event) => {
      'worklet';
      scale.value = clamp(startScale.value * event.scale, 1, MAX_SCALE);
    })
    .onEnd(() => {
      'worklet';
      if (scale.value <= ZOOMED) {
        scale.value = withTiming(1);
        x.value = withTiming(0);
        y.value = withTiming(0);
      } else {
        x.value = withTiming(clamp(x.value, -travel(width, scale.value), travel(width, scale.value)));
        y.value = withTiming(clamp(y.value, -travel(height, scale.value), travel(height, scale.value)));
      }
    });

  // Manual activation: while the image is not zoomed the pan fails at once and the horizontal pager scrolls.
  const pan = Gesture.Pan()
    .manualActivation(true)
    .onTouchesMove((_event, manager) => {
      'worklet';
      if (scale.value > ZOOMED) manager.activate();
      else manager.fail();
    })
    .onStart(() => {
      'worklet';
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((event) => {
      'worklet';
      const limitX = travel(width, scale.value);
      const limitY = travel(height, scale.value);
      x.value = clamp(startX.value + event.translationX, -limitX, limitX);
      y.value = clamp(startY.value + event.translationY, -limitY, limitY);
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event, success) => {
      'worklet';
      if (!success) return;
      if (scale.value > ZOOMED) {
        scale.value = withTiming(1);
        x.value = withTiming(0);
        y.value = withTiming(0);
        return;
      }
      // Zoom towards the tapped point.
      const limitX = travel(width, DOUBLE_TAP_SCALE);
      const limitY = travel(height, DOUBLE_TAP_SCALE);
      scale.value = withTiming(DOUBLE_TAP_SCALE);
      x.value = withTiming(clamp((width / 2 - event.x) * (DOUBLE_TAP_SCALE - 1), -limitX, limitX));
      y.value = withTiming(clamp((height / 2 - event.y) * (DOUBLE_TAP_SCALE - 1), -limitY, limitY));
    });

  const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height }}>
        <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
          <ExpoImage
            source={{ uri }}
            placeholder={previewUri === null ? undefined : { uri: previewUri }}
            contentFit="contain"
            transition={components.image.fadeMs}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
