const MQTT = require('async-mqtt');
const { mqtt: mqttConfig } = require('./config');

/**
 * @typedef {import('./device')} Device
 */

/**
 * MQTT Manager
 */
module.exports = class MQTTManager {
  /**
   * Create an MQTT manager for the specified devices
   *
   * @param {Device[]} devices Devices to manage
   */
  constructor(devices) {
    this.devices = devices;
  }

  async manageDevices() {
    this.mqtt = await MQTT.connectAsync(mqttConfig.brokerUrl, {
      username: mqttConfig.username,
      password: mqttConfig.password
    });

    await this.sendDiscovery();
  }

  async sendDiscovery() {
    // TODO:
  }

  async sendStateUpdate() {
    // TODO:
  }

  async onMessage(payload) {
    // TODO:
  }
};
