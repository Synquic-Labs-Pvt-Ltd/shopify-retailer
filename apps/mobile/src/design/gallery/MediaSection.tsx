import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  AppText,
  FloatingTabBar,
  Image,
  ListRow,
  MediaSlot,
  Panel,
  StickyFooter,
  PrimaryButton,
  colors,
  components,
  spacing,
  type FloatingTabItem,
} from '..';
import { GalleryItem, GallerySection } from './GallerySection';

const pic = (seed: string, width: number, height: number) => `https://picsum.photos/seed/rs-${seed}/${width}/${height}`;

const TABS: readonly FloatingTabItem[] = [
  { key: 'Products', label: 'Products', icon: 'pricetags-outline' },
  { key: 'Queue', label: 'Queue', icon: 'layers-outline' },
  { key: 'Account', label: 'Account', icon: 'person-outline' },
];

function Check({ selected }: { selected: boolean }) {
  return <View style={[styles.check, selected && styles.checkOn]} />;
}

export function MediaSection() {
  const [tab, setTab] = useState('Products');
  const [selected, setSelected] = useState(true);

  return (
    <>
      <GallerySection title="MEDIA SLOT">
        <GalleryItem caption="empty, uploading 60%, processing">
          <View style={styles.row}>
            <MediaSlot hint="Add" label="Empty" onPress={() => undefined} />
            <MediaSlot state="uploading" progress={0.6} uri={pic('slot-a', 192, 240)} label="Uploading" onRemove={() => undefined} />
            <MediaSlot state="processing" uri={pic('slot-b', 192, 240)} label="Processing" onRemove={() => undefined} />
          </View>
        </GalleryItem>
        <GalleryItem caption="ready image, ready video, failed">
          <View style={styles.row}>
            <MediaSlot state="ready" uri={pic('slot-c', 192, 240)} label="Image" onRemove={() => undefined} />
            <MediaSlot state="ready" isVideo uri={pic('slot-d', 192, 240)} label="Video" onRemove={() => undefined} />
            <MediaSlot state="failed" uri={pic('slot-e', 192, 240)} label="Failed" onPress={() => undefined} onRemove={() => undefined} />
          </View>
        </GalleryItem>
      </GallerySection>

      <GallerySection title="IMAGE">
        <View style={styles.row}>
          <Image uri={pic('tile', 300, 400)} aspectRatio={components.image.outputAspectRatio} radius={spacing.sm + spacing.xs} style={styles.tile} />
          <Image uri={null} aspectRatio={components.image.outputAspectRatio} radius={spacing.sm + spacing.xs} style={styles.tile} />
        </View>
      </GallerySection>

      <GallerySection title="LIST ROW AND PANEL">
        <ListRow label="Account details" hint="Store, domain and email" icon="person-outline" onPress={() => undefined} />
        <ListRow label="Queue" hint="3 batches running" icon="layers-outline" count={3} onPress={() => undefined} />
        <ListRow
          label="Ceramic Table Lamp"
          hint="5 media · Hearth & Co"
          thumbnailUri={pic('row', 104, 104)}
          haptic="selection"
          trailing={<Check selected={selected} />}
          onPress={() => setSelected((value) => !value)}
        />
        <ListRow label="Images per product" trailing={<AppText variant="cardTitle">2</AppText>} />
        <Panel>
          <AppText variant="cardTitle">Panel</AppText>
          <AppText variant="body" color={colors.meta}>
            White, radius 18, padding 16, gap 8. No shadow.
          </AppText>
        </Panel>
      </GallerySection>

      <GallerySection title="STICKY FOOTER">
        <View style={styles.footerStage}>
          <StickyFooter bleed={0} followKeyboard={false}>
            <AppText variant="meta" color={colors.meta}>
              3 selected
            </AppText>
            <PrimaryButton label="Continue" />
          </StickyFooter>
        </View>
      </GallerySection>

      <GallerySection title="FLOATING TAB BAR">
        <View style={styles.tabBarStage}>
          <FloatingTabBar tabs={TABS} activeKey={tab} onSelect={setTab} />
        </View>
      </GallerySection>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: { width: 120 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.hairline,
  },
  checkOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  tabBarStage: { height: 96, justifyContent: 'flex-end' },
  footerStage: { backgroundColor: colors.canvas },
});
