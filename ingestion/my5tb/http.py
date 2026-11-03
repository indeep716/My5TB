import random
import time
import requests

class HTTP:
    def __init__(self,session=None):
        self.session=session or requests.Session()
    def request(self,method,url,**kwargs):
        for attempt in range(6):
            response=self.session.request(method,url,timeout=(15,120),**kwargs)
            limited=response.status_code in (429,500,502,503,504)
            if response.status_code==403:
                limited=any(reason in response.text for reason in ('rateLimitExceeded','userRateLimitExceeded'))
            if not limited or attempt==5:
                return response
            delay=min(30,float(response.headers.get('Retry-After',2**attempt)))
            time.sleep(delay+random.random())
        raise RuntimeError('Unreachable')
