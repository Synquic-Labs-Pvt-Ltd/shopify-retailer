import { Image as ExpoImage } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { spacing } from '../../design';
import type { UsableOutput } from './outputs';
import { ViewerButton } from './ViewerButton';

export interface VideoPageProps {
  media: UsableOutput;
  // Only the page on screen holds a player.
  active: boolean;
  width: number;
  height: number;
}

// The poster stays under the video until it plays. Looping and muted by default.
export function VideoPage({ media, active, width, height }: VideoPageProps) {
  return (
    <View style={{ width, height }}>
      {media.previewUrl !== null && (
        <ExpoImage source={{ uri: media.previewUrl }} contentFit="contain" style={StyleSheet.absoluteFill} />
      )}
      {active && <ActiveVideo url={media.url} />}
    </View>
  );
}

function ActiveVideo({ url }: { url: string }) {
  const player = useVideoPlayer(url, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.play();
  });
  const [muted, setMuted] = useState(true);

  const toggleMute = () => {
    player.muted = !player.muted;
    setMuted(player.muted);
  };
  const togglePlay = () => {
    if (player.playing) player.pause();
    else player.play();
  };

  return (
    <>
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="contain"
        surfaceType="textureView"
        style={StyleSheet.absoluteFill}
      />
      <Pressable accessibilityLabel="Play or pause" onPress={togglePlay} style={StyleSheet.absoluteFill} />
      <ViewerButton
        icon={muted ? 'volume-mute-outline' : 'volume-high-outline'}
        accessibilityLabel={muted ? 'Turn sound on' : 'Mute'}
        onPress={toggleMute}
        style={styles.mute}
      />
    </>
  );
}

const styles = StyleSheet.create({
  mute: { position: 'absolute', right: spacing.md, bottom: spacing.xxl },
});
