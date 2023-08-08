const MQTT = require('async-mqtt');
const mem = require('mem');
const pRetry = require('p-retry');
const { mqtt: mqttConfig } = require('./config');
const { tempPercentToMireds, miredsToTempPercent, MAX_MIREDS, MIN_MIREDS } = require('./utils');

const AVAILABILITY_TOPIC = 'target_connected/availability';

/**
 * @typedef {import('./device')} Device
 */
/**
 * @typedef {Object} Topics
 * @prop {string} on Topic ID for on/off status
 * @prop {string} setOn Topic ID for setting on/off status
 * @prop {string} brightness Topic ID for brightness
 * @prop {string} setBrightness Topic ID for setting brightness
 * @prop {string} temperature Topic ID for color temperature
 * @prop {string} setTemperature Topic ID for setting color temperature
 */
/**
 * @typedef {Object} DeviceInfo
 * @prop {Device} device Device instance
 * @prop {Topics} topics Map of topic IDs
 */
/**
 * @callback CommandHandler
 * @param {string} value Value that was published to the topic
 * @returns {Promise<void>} Completion
 */

/**
 * MQTT Manager
 */
module.exports = class MQTTManager {
  /** @type {DeviceInfo[]} */
  #devices;
  /** @type {MQTT.AsyncMqttClient} */
  #mqtt;
  /** @type {Map<string, CommandHandler>} */
  #commandSubscriptions;

  /**
   * Create an MQTT manager for the specified devices
   *
   * @param {Device[]} devices Devices to manage
   */
  constructor(devices) {
    this.#devices = devices.map(d => ({
      device: d,
      topics: this.#buildTopicIds(d)
    }));
    this.#commandSubscriptions = new Map();
  }

  /**
   * Initialize the MQTT manager by connecting to the broker and setting up topic subscriptions
   *
   * @public
   */
  async init() {
    console.log('Connecting to MQTT broker...');
    this.#mqtt = await pRetry(async () => {
      return await MQTT.connectAsync(mqttConfig.brokerUrl, {
        username: mqttConfig.username,
        password: mqttConfig.password
      });
    }, {
      onFailedAttempt: error => {
        console.log(`Attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`);
      }
    });
    console.log('Connected to MQTT broker');

    await this.#setupTopics();
    await this.#sendDiscovery();
  }

  /**
   * Disconnect from the MQTT broker
   *
   * @public
   */
  async disconnect() {
    if (this.#mqtt.connected) {
      await this.#mqtt.publish(AVAILABILITY_TOPIC, 'offline', {
        retain: true
      });
      await this.#mqtt.end();
    }
  }

  /**
   * Build the topic IDs for the specified device
   *
   * @param {Device} device Device instance
   * @returns {Topics} Topic IDs
   */
  #buildTopicIds(device) {
    const base = `target_connected/${device.id}/`;
    const on = base + 'light/';
    const brightness = base + 'brightness/';
    const temperature = base + 'temperature/';

    return {
      on: on + 'status',
      setOn: on + 'switch',
      brightness: brightness + 'status',
      setBrightness: brightness + 'set',
      temperature: temperature + 'status',
      setTemperature: temperature + 'set'
    };
  }

  async #setupTopics() {
    this.#mqtt.publish(AVAILABILITY_TOPIC, 'online', {
      retain: true
    });
    for (const device of this.#devices) {
      // Subscribe to commands
      await this.#subscribeToCommandsForDevice(device);

      // Subscribe to device notifications and plumb to MQTT topics
      this.#subscribeToDeviceNotifications(device);

      // Publish current statuses
      await this.#publishDeviceStatuses(device);
    }
  }

  /**
   * Subscribe to command topics over MQTT for the specified device and prepare handlers
   *
   * @param {DeviceInfo} device Device to set up subscriptions for
   * @returns {Promise<void>} Completion
   */
  async #subscribeToCommandsForDevice(device) {
    console.log('Subscribing to command topics for', device.device.name);
    this.#commandSubscriptions.set(device.topics.setOn, mem(async value => {
      await device.device.setOn(value === 'ON');
    }, { maxAge: 500 }));
    this.#commandSubscriptions.set(device.topics.setBrightness, mem(async value => {
      let numValue = parseInt(value, 10);
      if (Number.isNaN(numValue)) numValue = 100;
      await device.device.setBrightness(numValue);
    }, { maxAge: 500 }));
    this.#commandSubscriptions.set(device.topics.setTemperature, mem(async value => {
      let numValue = parseInt(value, 10);
      if (Number.isNaN(numValue)) numValue = MAX_MIREDS;
      await device.device.setTemperature(miredsToTempPercent(numValue));
    }, { maxAge: 500 }));
    this.#mqtt.on('message', (topic, message) => {
      const handler = this.#commandSubscriptions.get(topic);
      if (handler) {
        handler(message.toString());
      }
    });
    await this.#mqtt.subscribe([device.topics.setOn, device.topics.setBrightness, device.topics.setTemperature]);
  }

  /**
   * Subscribe to device characteristic change notifications and plumb to MQTT
   *
   * @param {DeviceInfo} device Device to subscribe to
   */
  #subscribeToDeviceNotifications(device) {
    console.log('Subscribing to characteristic notifications for', device.device.name);
    device.device.subscribe('on', async isOn => {
      await this.#mqtt.publish(device.topics.on, isOn ? 'ON' : 'OFF', {
        retain: true
      });
    });
    device.device.subscribe('brightness', async brightness => {
      await this.#mqtt.publish(device.topics.brightness, brightness.toString(), {
        retain: true
      });
    });
    device.device.subscribe('temperature', async temperature => {
      await this.#mqtt.publish(device.topics.temperature, tempPercentToMireds(temperature).toString(), {
        retain: true
      });
    });
  }

  /**
   * Publish current device statuses
   *
   * @param {DeviceInfo} device Device to publish statuses for
   * @returns {Promise<void>} Completion
   */
  async #publishDeviceStatuses(device) {
    console.log('Publishing latest statuses for', device.device.name);
    await this.#mqtt.publish(device.topics.on, device.device.on ? 'ON' : 'OFF', {
      retain: true
    });
    typeof device.device.brightness === 'number' &&
      await this.#mqtt.publish(device.topics.brightness, device.device.brightness.toString(), {
        retain: true
      });
    typeof device.device.temperature === 'number' &&
      await this.#mqtt.publish(device.topics.temperature, tempPercentToMireds(device.device.temperature).toString(), {
        retain: true
      });
  }

  /**
   * Send discovery message to Home Assistant via the MQTT broker
   *
   * @returns {Promise<void>} Completion
   */
  async #sendDiscovery() {
    const discoveryTopicBase = 'homeassistant/light';

    for (const device of this.#devices) {
      console.log('Sending discovery message for', device.device.name);
      await this.#mqtt.publish(`${discoveryTopicBase}/target-connected-${device.device.id}/config`, JSON.stringify({
        avty_t: AVAILABILITY_TOPIC,
        bri_cmd_t: device.topics.setBrightness,
        bri_scl: 100,
        bri_stat_t: device.topics.brightness,
        clr_temp_cmd_t: device.topics.setTemperature,
        clr_temp_stat_t: device.topics.temperature,
        cmd_t: device.topics.setOn,
        dev: {
          ids: device.device.id,
          name: device.device.name,
          mf: 'Target',
          via_device: 'target-connected-mqtt'
        },
        ic: 'mdi:lamp',
        max_mirs: MAX_MIREDS,
        min_mirs: MIN_MIREDS,
        name: null, // Use device name
        stat_t: device.topics.on,
        uniq_id: 'target-connected-' + device.device.id
      }), {
        retain: true
      });
    }
  }
};
