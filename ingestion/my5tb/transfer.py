"""Cooperative transfer controls; requests already in flight finish safely."""
from threading import Condition

class UploadCancelled(Exception):
    pass

class TransferControl:
    def __init__(self):
        self.condition=Condition();self.paused=False;self.cancelled=False
    def pause(self):
        with self.condition:self.paused=True
    def resume(self):
        with self.condition:self.paused=False;self.condition.notify_all()
    def cancel(self):
        with self.condition:self.cancelled=True;self.condition.notify_all()
    def checkpoint(self):
        with self.condition:
            while self.paused and not self.cancelled:self.condition.wait(.2)
            if self.cancelled:raise UploadCancelled('Upload cancelled; completed models and uploaded files were kept')
