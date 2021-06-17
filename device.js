/**
 * Service identifiers
 * @const
 * @private
 */
const Services = {
  light: 'ffe8badce1cb46c69ad9631ea7cbadff'
};

/**
 * Characteristic identifiers
 * @const
 * @private
 */
const CharacteristicIds = {
  on: '00a268345cf448e5ae1c9e1234c03e00',
  brightness: 'bbe8badce1cb46c69ad9631ea7cba2bb',
  temperature: 'cce8badce1cb46c69ad9631ea7cba2cc'
}

/**
 * @typedef {Object} CharacteristicInfo
 * @prop {string} id Identifier of the characteristic
 * @prop {string} name Name of the characteristic
 * @prop {boolean} [isBool] Whether the characteristic is a boolean value
 */
/**
 * Characteristic information
 * @const
 * @private
 */
const Characteristics = {
  on: {
    id: CharacteristicIds.on,
    name: 'on',
    isBool: true
  },
  brightness: {
    id: CharacteristicIds.brightness,
    name: 'brightness'
  },
  temperature: {
    id: CharacteristicIds.temperature,
    name: 'temperature'
  }
};

/**
 * @typedef {import('@abandonware/noble').Characteristic} Characteristic
 * @typedef {import('@abandonware/noble').Peripheral} Peripheral
 * @typedef {{ (): Promise<any>, locked: Readonly<boolean> }} Lock
 */
/**
 * @typedef {Object} State
 * @prop {boolean} on Whether the light is on
 * @prop {number} brightness The brightness of the light
 * @prop {number} temperature The color temperature of the light
 */

module.exports = class Device {
  /**
   * Constructor
   * @param {Peripheral} peripheral Noble Peripheral object for device
   * @param {Lock} connectLock Lock mutex for connection
   */
  constructor(peripheral, connectLock) {
    this.peripheral = peripheral;
    this.connectLock = connectLock;
    /** @type {State} */
    this.state = {
      on: null,
      brightness: null,
      temperature: null
    };
    this.requestedDisconnect = false;
  }

  /**
   * Initialize the device
   *
   * @public
   */
  async init() {
    await this.refresh();
  }

  /**
   * Connect to the peripheral, ensuring that we only have one active connection at a time
   *
   * @returns {Promise<void>} Promise for completion of connection
   * @private
   */
  async connect() {
    const release = await this.connectLock();

    this.peripheral.once('connect', err => {
      if (err) {
        console.error('Connection error:', err);
        return;
      }

      console.log('Connected to', this.peripheral.id);

      if (this.op) {
        console.log(`Incomplete operation found, retrying (${--this.op.retriesRemaining} attempts remaining)`);
        this.op();
        if (this.op.retriesRemaining <= 0) {
          this.op = null;
        }
      }
    });

    this.peripheral.once('disconnect', err => {
      if (err) {
        console.error('Disconnection error:', err);
      } else {
        console.log('Disconnected from', this.peripheral.id);
      }

      release();

      if (this.requestedDisconnect) {
        this.requestedDisconnect = false;
      } else {
        console.log('Unexpected disconnection -- attempting reconnect');
        setImmediate(() => this.connect());
      }
    });

    await this.peripheral.connectAsync();

    // Connection can be slow and cause issues if we don't wait a bit after the connectAsync method resolves
    // see https://github.com/abandonware/noble/issues/62
    return wait(1000);
  }

  /**
   * Disconnect from the peripheral
   *
   * @returns {Promise<void>} Promise for completion of disconnection
   * @private
   */
  async disconnect() {
    this.requestedDisconnect = true;
    return this.peripheral.disconnectAsync();
  }

  /**
   * Attempt to run an operation with automatic retry if an unexpected disconnection occurs
   *
   * @param {() => Promise<T>} op Operation to run
   * @returns {Promise<T>} Result of the operation
   * @template T type of operation return value
   * @private
   */
  async runOperation(op) {
    this.op = () => new Promise(async (res, rej) => {
      try {
        await op();
      } catch (err) {
        rej(err);
        return;
      }
      this.op = null;
      res();
    });
    this.op.retriesRemaining = 5;

    return this.op();
  }

  /**
   * Connect to the peripheral and refresh device state
   *
   * @public
   */
  async refresh() {
    await this.connect();
    try {
      await this.runOperation(async () => this.updateState());
    } catch (err) {
      console.error(err);
    } finally {
      await this.disconnect();
    }
  }

  /**
   * Update state from a connected peripheral
   *
   * @private
   */
  async updateState() {
    this.name = this.peripheral.advertisement.localName;
    console.log(`Updating state for '${this.name}' (ID: ${this.peripheral.id})`);
    const res = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync([
      Services.light
    ], [
      CharacteristicIds.on,
      CharacteristicIds.brightness,
      CharacteristicIds.temperature
    ]);

    for (const c of res.characteristics) {
      if (c.uuid === CharacteristicIds.on)
        await this.updateCharacteristicState(c, 'on', true);
      else if (c.uuid === CharacteristicIds.brightness)
        await this.updateCharacteristicState(c, 'brightness');
      else if (c.uuid === CharacteristicIds.temperature)
        await this.updateCharacteristicState(c, 'temperature');
    }
    console.log(`Finished updating state for '${this.name}' (ID: ${this.peripheral.id})`);
  }

  /**
   * Update internally tracked state for a given characteristic
   *
   * @param {Characteristic} characteristic Characteristic to update from
   * @param {string} name Name of the characteristic (key in this.state)
   * @param {boolean} [isBool] Whether the value should be treated as a boolean, default false
   * @private
   */
  async updateCharacteristicState(characteristic, name, isBool = false) {
    await wait(500);
    const valAsUInt8 = await Device.readAsUInt8(characteristic);
    this.state[name] = isBool ? valAsUInt8 === 1 : valAsUInt8;
  }

  /**
   * Set the specified characteristic
   *
   * @param {CharacteristicInfo} characteristicInfo Characteristic Info for characteristic to set
   * @param {Buffer} value Value to set
   * @param {boolean} [withoutResponse] Whether to write without expecting a response
   * @returns {Promise<void>} Promise for completion
   * @private
   */
  async setCharacteristic(characteristicInfo, value, withoutResponse = false) {
    console.log(`Setting characteristic '${characteristicInfo.name}' for '${this.name}' (ID: ${this.peripheral.id})`);
    await this.connect();
    try {
      await this.runOperation(async () => {
        const { characteristics: [ ch ] } = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [Services.light], [characteristicInfo.id]);
        console.log('start write');
        await ch.writeAsync(value, withoutResponse);
        console.log('finished write, update state');
        await this.updateCharacteristicState(ch, characteristicInfo.name, characteristicInfo.isBool);
      });
    } catch (err) {
      console.error(err);
    } finally {
      await this.disconnect();
    }
  }

  /**
   * Get whether the device is on. Uses value from last refresh.
   *
   * @returns {boolean} true if the light is on, false if it is off
   * @public
   */
  get on() {
    return this.state.on;
  }

  /**
   * Set on-off value of light
   *
   * @param {boolean} value true to turn light on, false to turn off
   * @returns {Promise<void>} Promise for completion
   */
  async setOn(value) {
    const buf = Buffer.alloc(1, value ? 1 : 0);
    return this.setCharacteristic(Characteristics.on, buf);
  }

  /**
   * Get the brightness of the light. Values range from 1 (dimmest) to 100 (brightest).
   * Uses value from last refresh.
   *
   * @returns {number} Brightness value
   * @public
   */
  get brightness() {
    return this.state.brightness;
  }

  /**
   * Set brightness of the light
   *
   * @param {number} value brightness level, between 1-100
   * @returns {Promise<void>} Promise for completion
   * @public
   */
  async setBrightness(value) {
    const clamped = Math.max(1, Math.min(100, value));
    const buf = Buffer.alloc(1, 0);
    buf.writeUInt8(clamped);
    return this.setCharacteristic(Characteristics.brightness, buf, true);
  }

  /**
   * Get the color temperature of the light. Values range from 1 (warmest) to 100 (coolest).
   * Uses value from last refresh.
   *
   * @returns {number} Color temperature value
   * @public
   */
  get temperature() {
    return this.state.temperature;
  }

  /**
   * Set color temperature of the light
   *
   * @param {number} value color temperature, between 1-100 (1 is warmest, 100 is coolest)
   * @returns {Promise<void>} Promise for completion
   * @public
   */
  async setTemperature(value) {
    const clamped = Math.max(1, Math.min(100, value));
    const buf = Buffer.alloc(1, 0);
    buf.writeUInt8(clamped);
    return this.setCharacteristic(Characteristics.temperature, buf, true);
  }

  /**
   * Read a characteristic value as a uint8
   *
   * @param {Characteristic} characteristic Characteristic to read
   * @returns {Promise<number>} Characteristic value as a unit8
   * @private
   * @static
   */
  static async readAsUInt8(characteristic) {
    const value = await characteristic.readAsync();
    return value.readUInt8();
  }
};

/**
 * Wait the specified number of milliseconds
 *
 * @param {number} ms Milliseconds to wait
 * @returns {Promise<void>} Promise that resolves after the specified wait
 * @private
 */
async function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}
