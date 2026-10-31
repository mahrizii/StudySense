import uvicorn
from fastapi import FastAPI, HTTPException
import aiomqtt
import asyncio
from contextlib import asynccontextmanager
from sqlmodel import Field, SQLModel, Session, create_engine, select, UniqueConstraint
import json
from datetime import datetime, timezone 
from fastapi.middleware.cors import CORSMiddleware
import time
from dotenv import load_dotenv 
import os
from sqlalchemy import BigInteger
import httpx
from collections import deque

load_dotenv()
NOISE_MAX=600
TEMP_MAX=25
TEMP_MIN=19
HUMIDITY_MAX=60
HUMIDITY_MIN=30
LUX_MIN=100

CORS_ORIGINS= os.environ["CORS_ORIGINS"]
allow_origins= CORS_ORIGINS.split(",")
engine = create_engine(os.environ["DATABASE_URL"])
WEIGHTS={"noise":0.4, "temp":0.25,"light":0.25,"humidity": 0.1}

async def send_alert(text):
    try:
        async with httpx.AsyncClient(timeout=5) as http:
            await http.post(f"https://ntfy.sh/{os.environ['NTFY_TOPIC']}", content=text)
    except Exception as e:
        print(f"Alert failed: {e!r}")    
class Readings(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    device: str
    seq: int | None
    ts: int | None
    temp_c: float | None 
    humidity: float | None 
    pressure_hpa: float | None 
    lux: float | None
    noise: int | None
    received_at: int | None
    session_id: int | None = Field(default=None, foreign_key="sessiondata.id")
    ts_ms: int | None= Field(default=None, sa_type=BigInteger)
    received_at_ms: int | None = Field(default=None, sa_type=BigInteger)
    __table_args__= (
        UniqueConstraint("ts", "seq","device", name="unique_time_and_sequence")
    ,)
class SessionData(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    location: str
    session_start: int | None
    session_end: int | None
async def mqtt_subscriber():
    window=deque(maxlen=4)
    last_session_id=None
    state=True
    while True:
        try:



            async with aiomqtt.Client(os.environ["MQTT_HOST"], port=int(os.environ["MQTT_PORT"]), username=os.environ["MQTT_USERNAME"], password=os.environ["MQTT_PASSWORD"], tls_params=aiomqtt.TLSParameters(), identifier=os.environ["MQTT_CLIENT_ID"], clean_session=False) as client:
                await client.subscribe("spots/+/reading", qos=1)
                print("Connected to MQTT broker")
                async for message in client.messages:
                    try:
                        received_at_ms= time.time_ns()// 1000000
                        data=json.loads(message.payload)
                        with Session(engine) as session:
                            session_id = session.query(SessionData.id).filter(SessionData.session_end==None).first()
                            if (session_id is not None):
                                session_id = session_id.id
                            else:
                                session_id = None
                            reading = Readings(**data, received_at=int(datetime.now(tz=timezone.utc).timestamp()), session_id=session_id, received_at_ms=received_at_ms)

                            session.add(reading)
                            session.commit()

                            if (session_id is None):
                                continue
                            if session_id != last_session_id:
                                window.clear()
                                state=True
                                last_session_id=session_id
                            window.append(data)
                            if len(window)==4:
                                avg_lux = average([d.get("lux") for d in window])
                                avg_temp = average([d.get("temp_c") for d in window])
                                avg_noise = average([d.get("noise") for d in window])
                                avg_humidity = average([d.get("humidity") for d in window])   
                                problems=[]
                                if  avg_noise is not None and avg_noise > NOISE_MAX:
                                    problems.append("Noise is high")
                                if avg_lux is not None and avg_lux< LUX_MIN:
                                    problems.append("Light is too low")
                                if avg_humidity is not None and avg_humidity< HUMIDITY_MIN:
                                    problems.append("Humidity is too low")
                                if avg_humidity is not None and avg_humidity> HUMIDITY_MAX:
                                    problems.append("Humidity is too high")
                                if  avg_temp is not None and avg_temp< TEMP_MIN:
                                    problems.append("Temperature is too low")
                                if avg_temp is not None and avg_temp > TEMP_MAX:
                                    problems.append("Temperature is too high")

                                bad= len(problems)>0
                                if bad and state:
                                    await send_alert("⚠️ " + ", ".join(problems))
                                    state=False
                                elif not bad and not state:
                                    await send_alert("✅ Conditions are back to good")
                                    state=True
                    except Exception as e:
                        print(f"Skipped bad message: {e!r}")
        except Exception as e:
            print(f"Error occurred: {e}")
            await asyncio.sleep(5)

@asynccontextmanager
async def lifespan(app: FastAPI):
    SQLModel.metadata.create_all(engine)
    task=asyncio.create_task(mqtt_subscriber())
    yield
    task.cancel()
app=FastAPI(lifespan=lifespan)
app.add_middleware(
       CORSMiddleware,
       allow_origins=allow_origins,
       allow_methods=["*"],
       allow_headers=["*"],
   )
@app.post("/start_session")
def start_session(location: str):
    with Session(engine) as session:
        existing_session=session.query(SessionData).filter(SessionData.session_end==None).first()
        if existing_session:
            raise HTTPException(status_code=409, detail={"error": "A session is already active for the specified location."})
        else:
            new_session=SessionData(location=location, session_start=int(datetime.now(tz=timezone.utc).timestamp()), session_end=None)
            session.add(new_session)
            session.commit()
            session.refresh(new_session)
            return {"message": "Session started successfully.", "session_id": new_session.id}
@app.post("/end_session")
def end_session(location: str):
    with Session(engine) as session:
        session_data=session.query(SessionData).filter(SessionData.location==location, SessionData.session_end==None).first()
        if session_data:
            session_data.session_end=int(datetime.now(tz=timezone.utc).timestamp())
            session.commit()
        else:
            raise HTTPException(status_code=404, detail={"error": "No active session found."})
    return {"message": "Session ended successfully."}
@app.get("/active_session")
def active_session():
    with Session(engine) as session:
        active=session.query(SessionData).filter(SessionData.session_end==None).first()
        return active
@app.get("/readings/recent")
def recent_readings(limit: int = 120, session_id: int | None = None):
    with Session(engine) as session:
        q = session.query(Readings)
        if session_id is not None:
            q = q.filter(Readings.session_id == session_id)
        rows = q.order_by(Readings.id.desc()).limit(min(limit, 1000)).all()
        return list(reversed(rows)) 

def temp_score(avg_temp):
    if avg_temp is None:
        return None
    elif avg_temp <= 23 and avg_temp>= 20:
        temp_score=100
    elif avg_temp>23:
        temp_score=max(0,100-(20*(avg_temp-23)))
    else:
        temp_score=max(0,100-(20*(20-avg_temp)))
    return round(temp_score)
def humidity_score(avg_humidity):
    if avg_humidity is None:
        return None
    
    elif avg_humidity <= 60 and avg_humidity>= 30:
        humidity_score=100

    elif avg_humidity>60:
        humidity_score=max(0,100-(2*(avg_humidity-60)))

    else:
        humidity_score=max(0,100-(2*(30-avg_humidity)))

    return round(humidity_score)
def light_score(avg_lux):
    if avg_lux is None:
        return None
    elif avg_lux<300:
        light_score=round(max(0, 100-(0.3333*(300-avg_lux))))
    else:
        light_score=100
    return round(light_score)
def noise_score(avg_noise, quietest, loudest):
    if avg_noise is None:
        return None
    elif loudest==quietest:
        noiseScore=100
        return round(noiseScore)
    else:
        noiseScore= 100*((loudest-avg_noise)/(loudest-quietest))
        return round(noiseScore)
def total_score(temp_score,light_score,noise_score,humidity_score):
    weighted_sum=0
    weigh_used=0
    scores={"temp": temp_score, "humidity": humidity_score, "noise": noise_score, "light": light_score}
    for name, value in scores.items():
        if value is not None:
            weighted_sum += value*WEIGHTS[name]
            weigh_used+= WEIGHTS[name]
    if weigh_used==0:
        return None
    
    return round(weighted_sum/weigh_used)
def average(values):
    total=0
    count=0
    if not values:
        return None
    else:
        for value in values:
            if value is not None:
                total+=value
                count+=1
        if count ==0:
            return None
        else:
            avg=total/count
        return avg
        
@app.get("/rankings")
def ranking():
    with Session(engine) as session:
        groups={}
        spots=[]
        avg_noise_list=[]
        q= select(SessionData, Readings).where(Readings.session_id==SessionData.id)
        rows = session.exec(q).all()
        for session_data,reading in rows:
            key = session_data.location.strip().lower()
            if key not in groups:
                groups[key]= {"name": session_data.location, "temp":[],"humidity": [],"lux": [],"noise": [],"count": 0}
            groups[key]["name"]=session_data.location
            groups[key]["temp"].append(reading.temp_c)
            groups[key]["lux"].append(reading.lux)
            groups[key]["humidity"].append(reading.humidity)
            groups[key]["noise"].append(reading.noise)
            groups[key]["count"]+=1
        for value in groups.values():
            spot={}
            spot["name"]=value["name"]
            spot["avg_temp"]= average(value["temp"])
            spot["avg_humidity"]=average(value["humidity"])
            spot["avg_lux"]= average(value["lux"])
            spot["avg_noise"]= average(value["noise"])
            spot["count"]=value["count"]
            spots.append(spot)
        for spot in spots:
            if spot["avg_noise"] is not None:
                avg_noise_list.append(spot["avg_noise"])
        if avg_noise_list:
            loudest=max(avg_noise_list)
            quietest=min(avg_noise_list)
        else:
            loudest=None
            quietest=None
        for spot in spots:
            spot["temp_score"]= temp_score(spot["avg_temp"])
            spot["humidity_score"]= humidity_score(spot["avg_humidity"])
            spot["lux_score"]= light_score(spot["avg_lux"])
            spot["noise_score"]= noise_score(spot["avg_noise"], quietest, loudest)
            spot["score"]= total_score(spot["temp_score"],spot["lux_score"], spot["noise_score"],  spot["humidity_score"])
            spot["minutes"]= round(spot["count"]* (5/60))
        spots=sorted(spots, key=lambda x: (x['score'] is not None, x["score"] or 0),  reverse=True)
        return spots
@app.get("/health")
def health():
    return {"status": "ok"}