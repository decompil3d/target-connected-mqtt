const Graceful = require('node-graceful').default;
Graceful.captureExceptions = true;
Graceful.captureRejections = true;
Graceful.exitOnDouble = false;
const noble = require('@abandonware/noble');
const config = require('./config');
const Device = require('./device');
const MQTTManager = require('./mqtt');

noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    await noble.startScanningAsync(['dd649f0214fe11e5b60b1697f925ecdd'], false);
    console.log('Started scanning for devices');
  }
});

const peripherals = [];
const notYetFound = config?.ids?.slice();
if (!notYetFound) {
  console.log('config.ids is not set, so will output device IDs as they are found. Ctrl+C when you are satisfied');
}
noble.on('discover', async (peripheral) => {
  if (notYetFound) {
    const found = notYetFound.indexOf(peripheral.id);
    if (found > -1) {
      // Found one of the devices we're looking for
      console.log(`Found known device (ID: ${peripheral.id})`);
      peripherals.push(peripheral);
      notYetFound.splice(found, 1);
      if (notYetFound.length === 0) {
        // Found all devices we were looking for, so stop scanning
        console.log('Found all known devices');
        await noble.stopScanningAsync();
        console.log('Stopped scanning');
        await manageDevices(peripherals);
      }
    }
  } else {
    // No list of IDs set, so operate in data collection mode
    console.log(`Found device with ID ${peripheral.id}}`);
  }
});

/**
 * Manage devices
 *
 * @param {noble.Peripheral[]} devicePeripherals Peripheral objects for each device
 */
async function manageDevices(devicePeripherals) {
  Graceful.on('exit', (signal, details) => {
    if (details) {
      console.error('Exit reason:', details);
    }
  });

  const devices = devicePeripherals.map(dp => new Device(dp));

  Graceful.on('exit', async function () {
    console.log('Disconnecting Bluetooth LE connections before exit');
    await Promise.all(devices.map(d => d.disconnect()));
    console.log('Finished disconnecting Bluetooth LE');
  });

  // Initialize devices serially to avoid running too many BLE commands at once
  for (const device of devices) {
    await device.init();
  }

  const mqtt = new MQTTManager(devices);

  Graceful.on('exit', async function () {
    console.log('Disconnecting from MQTT broker before exit');
    await mqtt.disconnect();
    console.log('Finished disconnecting from MQTT broker');
  });

  await mqtt.init();
}
