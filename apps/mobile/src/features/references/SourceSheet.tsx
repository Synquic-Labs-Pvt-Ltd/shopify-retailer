import { BottomSheet, BottomSheetOption, PrimaryButton } from '../../design';
import type { PickSource } from './pickers';

export interface SourceSheetProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  onSelect: (source: PickSource) => void;
}

// SPEC 16.2: the source picker behind every "+" on the References screen.
export function SourceSheet({ visible, title, onClose, onSelect }: SourceSheetProps) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title}>
      <BottomSheetOption label="Take photo" icon="camera-outline" onPress={() => onSelect('photo')} />
      <BottomSheetOption label="Record video" icon="videocam-outline" onPress={() => onSelect('video')} />
      <BottomSheetOption label="Choose photos or videos" icon="images-outline" onPress={() => onSelect('library')} />
      <PrimaryButton label="Cancel" tone="ghost" onPress={onClose} />
    </BottomSheet>
  );
}
