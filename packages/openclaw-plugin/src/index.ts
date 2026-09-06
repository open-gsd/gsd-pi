import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PLUGIN_DESCRIPTION, PLUGIN_ID, PLUGIN_NAME, register } from "./plugin.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  register,
});
