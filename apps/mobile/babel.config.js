// babel-preset-expo adds the react-native-worklets plugin (needed by reanimated 4) automatically
// when react-native-worklets is installed, so no plugin entry is listed here.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
