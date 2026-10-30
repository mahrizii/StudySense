#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <BH1750.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <WiFiClientSecure.h>
#include <string.h>
#include <sys/time.h>
#include "secrets.h"
#include <HTTPClient.h>
/* Wifi variables*/
const char* ssid = WIFI_SSID;
const char* password=WIFI_PASSWORD;
const char* mqttUser= MQTT_USER;
const char* mqttPassword= MQTT_PASSWORD;
WiFiClientSecure espClient;
PubSubClient client(espClient);
/*Time Variables*/
const char *ntpServer="pool.ntp.org";
long long ts_ms;
struct timeval tv;
unsigned long lastPing= 0;
/*Sensors Variables*/
const int micPin= 34;
int sample;
float Humidity;
float Temp;
float Pressure;
float lux;
bool bmeStatus;
bool lightStatus;
int micMax;
int relativeNoise;
unsigned long start;
int micMin;
char buffer[512];
Adafruit_BME280 bme;
BH1750 lightMeter;
JsonDocument doc;
int x=0;

void setup() {
  Serial.begin(9600);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nConnected successfully!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP()); 
  Serial.println("\nStarting connection to server...");
  espClient.setInsecure();
  client.setServer(MQTT_HOST,MQTT_PORT);
  client.setBufferSize(512);
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection...");
    String clientId="ESP32Client-";
    clientId+= String(random(0xffff), HEX);
    if (client.connect(clientId.c_str(), mqttUser,mqttPassword, "spots/node1/status", 1, true, "offline")) {
      client.publish("spots/node1/status", "online", true);
      Serial.println("connected to MQTT");
  } else {
    Serial.print("failed");
    Serial.print(client.state());
    Serial.println("try again in 5 seconds");
    delay(5000);
  }
  }
  Wire.begin();
  healthPing();

  bmeStatus=bme.begin(0x76);
  lightStatus=lightMeter.begin();
  doc["device"]= "node1";
  configTime(0, 0, ntpServer);
  while (time(nullptr)<=  1700000000) {
    Serial.println("Correcting the time...");
    delay(500);
  }
  Serial.println("Time has been corrected!");
} 
void healthPing() {
  WiFiClientSecure *client= new WiFiClientSecure;
  HTTPClient https;
  Serial.println("[HTTPS] begin... \n");
  client->setInsecure();
  https.begin(*client, GET_HEALTH);
  https.setTimeout(10000);
  int httpCode= https.GET();

  if (httpCode>0) {
    Serial.println("Success");


  } else {
    Serial.printf("[HTTPS] GET... failed, error: %s\n", https.errorToString(httpCode).c_str());
    }
  https.end();
  delete client;
}
void loop() {
  client.loop();
  Temp= bme.readTemperature();
  Temp= round(Temp*10)/10.0;
  Pressure= bme.readPressure();
  Pressure=round(Pressure);
  Humidity=bme.readHumidity();
  Humidity= round(Humidity);
  micMax=0;
  micMin=4095;
  start=millis();
  while (millis()-start<=50) {
    sample= analogRead(micPin);
    if (sample > micMax) micMax=sample;
    if (sample < micMin) micMin=sample;
  }
  relativeNoise= micMax-micMin;
  lux = lightMeter.readLightLevel();
  lux= round(lux);
  x++;

  doc["seq"]=x;
  if (bmeStatus){
    doc["temp_c"]= Temp;
    doc["humidity"]= Humidity;
    doc["pressure_hpa"]= Pressure/ 100.0F;

  }
  else {
    doc["temp_c"]= nullptr;
    doc["humidity"]= nullptr;
    doc["pressure_hpa"]= nullptr;
  }
  if (lightStatus) {
    doc["lux"]=lux;
  }
  else {
    doc["lux"]= nullptr;
  }
  
  doc["noise"]=relativeNoise;
  doc["ts"]=time(nullptr);
  gettimeofday(&tv, nullptr);
  ts_ms= ((long long)tv.tv_sec*1000)+(tv.tv_usec/1000);
  doc["ts_ms"]= ts_ms;
  serializeJson(doc, buffer);
  client.publish("spots/node1/reading", buffer);
  if (millis() - lastPing >= 600000) {
    healthPing();
    lastPing= millis();
  }
  delay(5000);
}