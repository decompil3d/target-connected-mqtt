const mem = require('mem');

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
};

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
 */
/**
 * @typedef {Object} State
 * @prop {boolean} [on] Whether the light is on
 * @prop {number} [brightness] The brightness of the light
 * @prop {number} [temperature] The color temperature of the light
 */
/**
 * @typedef {(T) => void} SubscribedCallback
 * @template T Type of value
 */
/**
 * @typedef {Object} Subscriptions
 * @prop {SubscribedCallback<boolean>[]} on Callback(s) to call when the on/off state changes
 * @prop {SubscribedCallback<number>[]} brightness Callback(s) to call when the brightness state changes
 * @prop {SubscribedCallback<number>[]} temperature Callback(s) to call when the color temperature state changes
 */

module.exports = class Device {
  /** @type {Peripheral} */
  #peripheral;
  /** @type {State} */
  #state;
  /** @type {boolean} */
  #requestedDisconnect;
  /** @type {Subscriptions} */
  #subscriptions;
  /** @type {(Function & { retriesRemaining: number }) | undefined} */
  #op;
  /** @type {CharacteristicsSet | undefined} */
  #characteristics;
  /** @type {string} */
  #name;

  /**
   * Constructor
   * @param {Peripheral} peripheral Noble Peripheral object for device
   */
  constructor(peripheral) {
    this.#peripheral = peripheral;
    this.#state = {
      on: void 0,
      brightness: void 0,
      temperature: void 0
    };
    this.#requestedDisconnect = false;

    this.#subscriptions = {
      on: [],
      brightness: [],
      temperature: []
    };

    // To improve typings, we assign `this.subscribe` here with a @type tag -- this allows us to use the typings for
    // the overloads of this method properly.
    /**
     * Subscribe to changes for the specified characteristic
     * @type {SubscribeFn}
     * @public
     */
    this.subscribe = this._subscribe;
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
   */
  async #connect() {
    if (this.#peripheral.state === 'connected') return;

    this.#peripheral.once('connect', err => {
      if (err) {
        console.error('Connection error:', err);
        return;
      }

      console.log('Connected to', this.#peripheral.id);

      if (this.#op) {
        console.log(`Incomplete operation found, retrying (${--this.#op.retriesRemaining} attempts remaining)`);
        this.#op();
        if (this.#op.retriesRemaining <= 0) {
          this.#op = void 0;
        }
      }
    });

    this.#peripheral.once('disconnect', err => {
      if (err) {
        console.error('Disconnection error:', err);
      } else {
        console.log('Disconnected from', this.#peripheral.id);
      }

      if (this.#requestedDisconnect) {
        this.#requestedDisconnect = false;
      } else {
        console.log('Unexpected disconnection -- attempting reconnect');
        setImmediate(() => this.#connect());
      }
    });

    await this.#peripheral.connectAsync();

    // Connection can be slow and cause issues if we don't wait a bit after the connectAsync method resolves
    // see https://github.com/abandonware/noble/issues/62
    await wait(1000);

    this.#characteristics = await this.#discoverCharacteristics();

    return this.#subscribeToCharacteristics();
  }

  /**
   * Disconnect from the peripheral
   *
   * @returns {Promise<void>} Promise for completion of disconnection
   * @public
   */
  async disconnect() {
    if (this.#peripheral.state === 'disconnected') return;
    this.#requestedDisconnect = true;
    this.#characteristics = void 0;
    return this.#peripheral.disconnectAsync();
  }

  /**
   * Subscribe to peripheral state updates
   */
  async #subscribeToCharacteristics() {
    if (!this.#characteristics) {
      throw new Error('Cannot subscribe to characteristics before they are discovered');
    }
    for (const ci of Object.values(Characteristics)) {
      /** @type {Characteristic} */
      const ch = this.#characteristics[ci.name];
      ch.on('data', /** @param {Buffer} data Data sent */ data => {
        // Read data
        /** @type {number|boolean} */
        let val = data.readUInt8();
        if (ci.isBool) val = val === 1;

        // Save into state
        this.#state[ci.name] = val;

        // Notify subscribers
        this.#subscriptions[ci.name].forEach(cb => cb(val));
      });

      await ch.subscribeAsync();
    }
  }

  /**
   * @callback SubscribeOn
   * @param {'on'} characteristicName Name of the characteristic to subscribe to
   * @param {SubscribedCallback<boolean>} cb Callback when subscribed characteristic changes
   * @returns {Promise<void>}
   */
  /**
   * @callback SubscribeBrightnessTemperature
   * @param {'brightness'|'temperature'} characteristicName Name of the characteristic to subscribe to
   * @param {SubscribedCallback<number>} cb Callback when subscribed characteristic changes
   * @returns {Promise<void>}
   */
  /**
   * @typedef {{
   * (characteristicName: 'on', cb: SubscribedCallback<boolean>): Promise<void>
   * (characteristicName: 'brightness'|'temperature', cb: SubscribedCallback<number>): Promise<void>
   * }} SubscribeFn
   */
  /**
   * Subscribe to changes for the specified characteristic
   *
   * Typings here are intentionally broad -- callers will use this.subscribe which is properly typed in the constructor
   *
   * @param {'on'|'brightness'|'temperature'} characteristicName Name of the characteristic to subscribe to
   * @param {SubscribedCallback<T>} cb Callback when subscribed characteristic changes
   * @template T
   * @private
   */
  async _subscribe(characteristicName, cb) {
    if (!(characteristicName in this.#subscriptions)) {
      throw new Error('Invalid subscription characteristic name');
    }
    this.#subscriptions[characteristicName].push(mem(cb, {
      maxAge: 1000
    }));
  }

  /**
   * @typedef {() => Promise<T>} Operation
   * @template T
   */
  /**
   * Attempt to run an operation with automatic retry if an unexpected disconnection occurs
   *
   * @param {Operation<T>} op Operation to run
   * @returns {Promise<T>} Result of the operation
   * @template T type of operation return value
   */
  async #runOperation(op) {
    const operation = () => new Promise((res, rej) => {
      op()
        .then((result) => {
          this.#op = void 0;
          res(result);
        })
        .catch(rej);
    });
    operation.retriesRemaining = 5;
    this.#op = operation;

    return this.#op();
  }

  /**
   * Connect to the peripheral and refresh device state
   *
   * @public
   */
  async refresh() {
    await this.#connect();
    try {
      await this.#runOperation(async () => this.#updateState());
    } catch (err) {
      console.error(err);
    }
  }

  /**
   * @typedef {Object} CharacteristicsSet
   * @prop {Characteristic} on Characteristic tracking on/off state
   * @prop {Characteristic} brightness Characteristic tracking brightness state
   * @prop {Characteristic} temperature Characteristic tracking color temperature state
   */
  /**
   * Discover characteristics of a peripheral
   *
   * @returns {Promise<CharacteristicsSet>} Set of Characteristic objects loaded from the device
   */
  async #discoverCharacteristics() {
    const res = await this.#peripheral.discoverSomeServicesAndCharacteristicsAsync([
      Services.light
    ], [
      CharacteristicIds.on,
      CharacteristicIds.brightness,
      CharacteristicIds.temperature
    ]);

    const ret = {};
    for (const c of res.characteristics) {
      if (c.uuid === CharacteristicIds.on)
        ret.on = c;
      else if (c.uuid === CharacteristicIds.brightness)
        ret.brightness = c;
      else if (c.uuid === CharacteristicIds.temperature)
        ret.temperature = c;
    }

    return ret;
  }

  /**
   * Update state from a connected peripheral
   */
  async #updateState() {
    this.#name = this.#peripheral.advertisement.localName;
    if (!this.#characteristics)
      return;
    console.log(`Updating state for '${this.#name}' (ID: ${this.#peripheral.id})`);
    await this.#updateCharacteristicState(this.#characteristics.on, 'on', true);
    await this.#updateCharacteristicState(this.#characteristics.brightness, 'brightness');
    await this.#updateCharacteristicState(this.#characteristics.temperature, 'temperature');
    console.log(`Finished updating state for '${this.#name}' (ID: ${this.#peripheral.id})`);
  }

  /**
   * Update internally tracked state for a given characteristic
   *
   * @param {Characteristic} characteristic Characteristic to update from
   * @param {string} name Name of the characteristic (key in this.state)
   * @param {boolean} [isBool] Whether the value should be treated as a boolean, default false
   */
  async #updateCharacteristicState(characteristic, name, isBool = false) {
    await wait(500);
    const valAsUInt8 = await Device.#readAsUInt8(characteristic);
    this.#state[name] = isBool ? valAsUInt8 === 1 : valAsUInt8;
  }

  /**
   * Set the specified characteristic
   *
   * @param {CharacteristicInfo} characteristicInfo Characteristic Info for characteristic to set
   * @param {Buffer} value Value to set
   * @param {boolean} [withoutResponse] Whether to write without expecting a response
   * @returns {Promise<void>} Promise for completion
   */
  async #setCharacteristic(characteristicInfo, value, withoutResponse = false) {
    console.log(`Setting characteristic '${characteristicInfo.name}' for '${this.#name}' (ID: ${this.#peripheral.id})`);
    await this.#connect();
    try {
      await this.#runOperation(async () => {
        if (!this.#characteristics) {
          throw new Error('Cannot set characteristic before characteristics are discovered');
        }
        const ch = this.#characteristics[characteristicInfo.name];
        await ch.writeAsync(value, withoutResponse);
        if (characteristicInfo.name === 'on' && this.#state.brightness === 0) {
          // Light just turned on, so update brightness value
          await this.#updateCharacteristicState(this.#characteristics.brightness, 'brightness');

          // And notify subscribers
          this.#subscriptions.brightness.forEach(s => s(this.#state.brightness));
        }
      });
    } catch (err) {
      console.error(err);
    }
  }

  /**
   * Get device peripheral ID
   *
   * @returns {string} Device peripheral ID
   * @public
   */
  get id() {
    return this.#peripheral.id;
  }

  /**
   * Get device name
   *
   * @returns {string} Device name
   * @public
   */
  get name() {
    return this.#name;
  }

  /**
   * Get whether the device is on. Uses value from last refresh.
   *
   * @returns {boolean} true if the light is on, false if it is off
   * @public
   */
  get on() {
    return !!this.#state.on;
  }

  /**
   * Set on-off value of light
   *
   * @param {boolean} value true to turn light on, false to turn off
   * @returns {Promise<void>} Promise for completion
   */
  async setOn(value) {
    const buf = Buffer.alloc(1, value ? 1 : 0);
    return this.#setCharacteristic(Characteristics.on, buf);
  }

  /**
   * Get the brightness of the light. Values range from 1 (dimmest) to 100 (brightest).
   * Uses value from last refresh.
   *
   * @returns {number | undefined} Brightness value
   * @public
   */
  get brightness() {
    return this.#state.brightness;
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
    return this.#setCharacteristic(Characteristics.brightness, buf, true);
  }

  /**
   * Get the color temperature of the light. Values range from 1 (warmest) to 100 (coolest).
   * Uses value from last refresh.
   *
   * @returns {number | undefined} Color temperature value
   * @public
   */
  get temperature() {
    return this.#state.temperature;
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
    return this.#setCharacteristic(Characteristics.temperature, buf, true);
  }

  /**
   * Read a characteristic value as a uint8
   *
   * @param {Characteristic} characteristic Characteristic to read
   * @returns {Promise<number>} Characteristic value as a unit8
   * @static
   */
  static async #readAsUInt8(characteristic) {
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
