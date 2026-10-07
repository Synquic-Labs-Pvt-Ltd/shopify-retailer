import type { NavigatorScreenParams } from '@react-navigation/native';

export type AuthStackParamList = {
  Login: undefined;
};

export type TabParamList = {
  Products: undefined;
  Queue: undefined;
  Account: undefined;
};

// The selection and references live in the persisted draft store, so References takes no params.
export type MainStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  References: undefined;
  BatchDetail: { batchId: string };
  ItemResults: { batchId: string; itemId: string };
  MediaViewer: { batchId: string; itemId: string; initialMediaId: string };
  // Registered in development builds only (__DEV__).
  DesignGallery: undefined;
};

declare global {
  namespace ReactNavigation {
    interface RootParamList extends MainStackParamList, AuthStackParamList {}
  }
}
