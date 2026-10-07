import * as ImagePicker from 'expo-image-picker';
import { normalizeAsset, type PickedAsset } from './pickedAsset';

export type PickSource = 'photo' | 'video' | 'library';

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export interface PickOptions {
  // Longest video the camera may record, in seconds.
  maxVideoSeconds: number;
  // How many more files the target can take (at least 1).
  remaining: number;
}

async function ensureCameraPermission(): Promise<void> {
  const current = await ImagePicker.getCameraPermissionsAsync();
  if (current.granted) return;
  const requested = await ImagePicker.requestCameraPermissionsAsync();
  if (!requested.granted) {
    throw new PermissionDeniedError('Allow camera access in Settings to take reference photos and videos.');
  }
}

function toAssets(result: ImagePicker.ImagePickerResult): PickedAsset[] {
  return result.canceled ? [] : result.assets.map(normalizeAsset);
}

// Opens the camera or the library. Resolves with no assets when the user cancels.
// The Android photo picker needs no storage permission.
export async function pickAssets(source: PickSource, options: PickOptions): Promise<PickedAsset[]> {
  switch (source) {
    case 'photo':
      await ensureCameraPermission();
      return toAssets(await ImagePicker.launchCameraAsync({ mediaTypes: ['images'] }));
    case 'video':
      await ensureCameraPermission();
      return toAssets(
        await ImagePicker.launchCameraAsync({ mediaTypes: ['videos'], videoMaxDuration: options.maxVideoSeconds }),
      );
    case 'library':
      return toAssets(
        await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images', 'videos'],
          allowsMultipleSelection: options.remaining > 1,
          selectionLimit: Math.max(1, options.remaining),
          orderedSelection: true,
        }),
      );
  }
}
